package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestAPIClientToolLoop(t *testing.T) {
	var requests atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer test-key" || r.Header.Get("cf-aig-gateway-id") != "kavla" {
			t.Errorf("unexpected API request: %s", r.URL.Path)
		}
		var body struct {
			Model string `json:"model"`
			Stream *bool `json:"stream"`
			Tools []struct { Function struct { Name string `json:"name"`; Parameters map[string]interface{} `json:"parameters"` } `json:"function"` } `json:"tools"`
			Messages []map[string]json.RawMessage `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil { t.Error(err); return }
		if body.Model != "test-model" || body.Stream == nil || *body.Stream { t.Errorf("request must use the configured model without streaming") }
		if len(body.Tools) != 14 || body.Tools[0].Function.Name != "get_canvas_context" || body.Tools[0].Function.Parameters["type"] != "object" { t.Errorf("missing Kavla function schemas: %+v", body.Tools) }
		w.Header().Set("Content-Type", "application/json")
		if requests.Add(1) == 1 {
			if !strings.Contains(string(body.Messages[1]["content"]), "Earlier conversation") { t.Error("missing fallback history") }
			fmt.Fprint(w, `{"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"reasoning_content":"preserve provider reasoning","tool_calls":[{"id":"call-1","type":"function","function":{"name":"create_note","arguments":"{\"text\":\"Hello\"}"}},{"id":"call-2","type":"function","function":{"name":"get_canvas_context","arguments":"{}"}}]}}]}`)
			return
		}
		if len(body.Messages) != 5 { t.Errorf("expected assistant and both tool results, got %d messages", len(body.Messages)) } else {
			if string(body.Messages[2]["reasoning_content"]) != `"preserve provider reasoning"` { t.Error("lost provider reasoning field") }
			if string(body.Messages[3]["tool_call_id"]) != `"call-1"` || string(body.Messages[4]["tool_call_id"]) != `"call-2"` { t.Error("tool results out of order") }
			if !strings.Contains(string(body.Messages[3]["content"]), "shape:note") { t.Error("missing canvas tool result") }
		}
		fmt.Fprint(w, `{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Created the note."}}]}`)
	}))
	defer provider.Close()
	done := make(chan map[string]interface{}, 1)
	texts := make(chan string, 2)
	var client *APIClient
	var err error
	client, err = NewAPIClient(context.Background(), APIConfig{BaseURL: provider.URL + "/v1", APIKey: "test-key", Model: "test-model", Headers: map[string]string{"cf-aig-gateway-id": "kavla"}},
		func(method string, raw json.RawMessage) {
			var event map[string]interface{}
			if err := json.Unmarshal(raw, &event); err != nil { t.Error(err); return }
			if method == "turn/completed" { done <- event["turn"].(map[string]interface{}) }
			if method == "item/completed" { texts <- event["item"].(map[string]interface{})["text"].(string) }
		},
		func(id, raw json.RawMessage) {
			var call struct { Namespace, Tool string; Arguments map[string]interface{} }
			if err := json.Unmarshal(raw, &call); err != nil { t.Error(err); return }
			if call.Namespace != "kavla" { t.Error("missing canvas namespace") }
			if err := client.RespondToTool(id, true, map[string]string{"shapeId": "shape:note"}); err != nil { t.Error(err) }
		})
	if err != nil { t.Fatal(err) }
	defer client.Close()
	thread, resumed, err := client.StartOrResumeThread(context.Background(), "old-codex-thread", "test-model")
	if err != nil || resumed { t.Fatalf("start thread: resumed=%v, err=%v", resumed, err) }
	prompt, err := BuildPrompt("Create a note", map[string]interface{}{}, "Earlier conversation")
	if err != nil { t.Fatal(err) }
	if _, err := client.StartTurn(context.Background(), thread, prompt); err != nil { t.Fatal(err) }
	select {
	case turn := <-done:
		if turn["status"] != "completed" { t.Fatalf("turn failed: %+v", turn) }
	case <-time.After(3*time.Second): t.Fatal("tool loop did not finish")
	}
	if requests.Load() != 2 { t.Fatalf("expected two API calls, got %d", requests.Load()) }
	if text := <-texts; text != "Created the note." { t.Fatal(text) }
}

func TestAPIClientLensGeneration(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil { t.Error(err); return }
		if body["stream"] != false || body["tools"] != nil { t.Error("focused generation must use complete text without tools") }
		messages := body["messages"].([]interface{})
		instructions := messages[0].(map[string]interface{})["content"].(string)
		content := ""
		if instructions == lensDeveloperInstructions { content = `{"code":"export default function Lens() { return null; }"}` }
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"choices": []interface{}{map[string]interface{}{"finish_reason": "stop", "message": map[string]string{"role": "assistant", "content": content}}}})
	}))
	defer provider.Close()
	client, err := NewAPIClient(context.Background(), APIConfig{BaseURL: provider.URL, Model: "test-model"}, nil, nil)
	if err != nil { t.Fatal(err) }
	defer client.Close()
	result, err := client.GenerateLens(context.Background(), "test-model", "Generate", nil)
	if err != nil { t.Fatal(err) }
	if result["code"] == nil { t.Fatal(result) }
}

func TestAPIClientInterruptsPendingTool(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"pending-call","type":"function","function":{"name":"create_note","arguments":"{\"text\":\"hello\"}"}}]}}]}`)
	}))
	defer provider.Close()
	requested := make(chan json.RawMessage, 1)
	done := make(chan json.RawMessage, 1)
	client, err := NewAPIClient(context.Background(), APIConfig{BaseURL: provider.URL, Model: "test-model"},
		func(method string, raw json.RawMessage) { if method == "turn/completed" { done <- raw } },
		func(id, raw json.RawMessage) { requested <- id })
	if err != nil { t.Fatal(err) }
	defer client.Close()
	thread, _, err := client.StartOrResumeThread(context.Background(), "", "test-model")
	if err != nil { t.Fatal(err) }
	turn, err := client.StartTurn(context.Background(), thread, "Create a note")
	if err != nil { t.Fatal(err) }
	var requestID json.RawMessage
	select { case requestID = <-requested: case <-time.After(3*time.Second): t.Fatal("tool was not requested") }
	if err := client.InterruptTurn(context.Background(), thread, turn); err != nil { t.Fatal(err) }
	select {
	case raw := <-done: if !strings.Contains(string(raw), `"status":"interrupted"`) { t.Fatal(string(raw)) }
	case <-time.After(3*time.Second): t.Fatal("waiting tool did not cancel")
	}
	if err := client.RespondToTool(requestID, true, nil); err == nil { t.Fatal("accepted a late tool result") }
	if _, _, err := client.StartOrResumeThread(context.Background(), thread, "test-model"); err != nil { t.Fatalf("cannot start after interruption: %v", err) }
}

func TestAPIClientFinalizesAtToolBudget(t *testing.T) {
	var requests atomic.Int32
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil { t.Error(err); return }
		step := requests.Add(1)
		if step <= 16 {
			fmt.Fprintf(w, `{"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"call-%d","type":"function","function":{"name":"get_canvas_context","arguments":"{}"}}]}}]}`, step)
		} else {
			if body["tools"] != nil { t.Error("tools still enabled after budget exhaustion") }
			fmt.Fprint(w, `{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Final answer using available evidence."}}]}`)
		}
	}))
	defer provider.Close()
	done := make(chan json.RawMessage, 1)
	var client *APIClient
	var err error
	client, err = NewAPIClient(context.Background(), APIConfig{BaseURL: provider.URL, Model: "test-model"},
		func(method string, raw json.RawMessage) { if method == "turn/completed" { done <- raw } },
		func(id, raw json.RawMessage) { calls.Add(1); if err := client.RespondToTool(id, true, nil); err != nil { t.Error(err) } })
	if err != nil { t.Fatal(err) }
	defer client.Close()
	thread, _, err := client.StartOrResumeThread(context.Background(), "", "test-model")
	if err != nil { t.Fatal(err) }
	if _, err := client.StartTurn(context.Background(), thread, "Analyze"); err != nil { t.Fatal(err) }
	select {
	case raw := <-done: if !strings.Contains(string(raw), `"status":"completed"`) { t.Fatal(string(raw)) }
	case <-time.After(3*time.Second): t.Fatal("tool budget did not terminate")
	}
	if requests.Load() != 17 || calls.Load() != 16 { t.Fatalf("requests=%d, calls=%d", requests.Load(), calls.Load()) }
}

func TestAPIClientCancellation(t *testing.T) {
	started := make(chan struct{})
	cancelled := make(chan struct{})
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(started)
		<-r.Context().Done()
		close(cancelled)
	}))
	defer provider.Close()
	client, err := NewAPIClient(context.Background(), APIConfig{BaseURL: provider.URL, Model: "test-model"}, nil, nil)
	if err != nil { t.Fatal(err) }
	defer client.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := client.GenerateLens(ctx, "test-model", "test", nil); done <- err }()
	select { case <-started: case <-time.After(3*time.Second): t.Fatal("request did not start") }
	cancel()
	select { case err := <-done: if !errors.Is(err, context.Canceled) { t.Fatalf("expected cancellation, got %v", err) }; case <-time.After(3*time.Second): t.Fatal("request did not cancel") }
	select { case <-cancelled: case <-time.After(3*time.Second): t.Fatal("provider request is still running") }
}

type apiTestTransport func(*http.Request) (*http.Response, error)

func (transport apiTestTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func TestAPILensGenerationKeepsLongerDeadline(t *testing.T) {
	client, err := NewAPIClient(context.Background(), APIConfig{BaseURL: "https://provider.example/v1", Model: "test-model"}, nil, nil)
	if err != nil { t.Fatal(err) }
	defer client.Close()
	client.httpClient.Transport = apiTestTransport(func(request *http.Request) (*http.Response, error) {
		deadline, ok := request.Context().Deadline()
		remaining := time.Until(deadline)
		if !ok || remaining < 8*time.Minute || remaining > 9*time.Minute { t.Errorf("HTTP client shortened Lens deadline: %s", remaining) }
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"{\"code\":\"Lens\"}"}}]}`))}, nil
	})
	ctx, cancel := context.WithTimeout(context.Background(), 9*time.Minute)
	defer cancel()
	if _, err := client.GenerateLens(ctx, "test-model", "Generate a Lens", nil); err != nil { t.Fatal(err) }
}

func TestAPIClientRejectsIncompleteResponses(t *testing.T) {
	for _, body := range []string{
		`{"choices":[]}`,
		`{"choices":[{"finish_reason":"length","message":{"role":"assistant","content":"partial"}}]}`,
		`{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":null}}]}`,
		`data: {"choices":[]}`,
	} {
		t.Run(body, func(t *testing.T) {
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, body) }))
			defer provider.Close()
			client, err := NewAPIClient(context.Background(), APIConfig{BaseURL: provider.URL, Model: "test-model"}, nil, nil)
			if err != nil { t.Fatal(err) }
			defer client.Close()
			if _, err := client.complete(context.Background(), "test-model", nil, nil); err == nil { t.Fatal("accepted incomplete response") }
		})
	}
}

func TestAPIClientRedactsErrorsAndRejectsRedirects(t *testing.T) {
	var forwarded atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { forwarded.Store(true) }))
	defer target.Close()
	for _, status := range []int{http.StatusUnauthorized, http.StatusTemporaryRedirect} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Location", target.URL)
				w.WriteHeader(status)
				fmt.Fprint(w, "key-secret gateway-secret")
			}))
			defer provider.Close()
			client, err := NewAPIClient(context.Background(), APIConfig{BaseURL: provider.URL, APIKey: "key-secret", Model: "test-model", Headers: map[string]string{"cf-aig-authorization": "Bearer gateway-secret"}}, nil, nil)
			if err != nil { t.Fatal(err) }
			defer client.Close()
			_, err = client.complete(context.Background(), "test-model", nil, nil)
			if err == nil || strings.Contains(err.Error(), "key-secret") || strings.Contains(err.Error(), "gateway-secret") { t.Fatalf("expected a redacted provider error, got %v", err) }
		})
	}
	if forwarded.Load() { t.Fatal("credentials were forwarded through a redirect") }
}
