package localapp

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aleda145/kavla/cli/internal/codex"
)

func newAPIAgentTestServer(t *testing.T) *Server {
	t.Helper()
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	for _, name := range []string{"OPENAI_API_KEY", "OPENAI_BASE_URL", "KAVLA_AI_API_KEY", "KAVLA_AI_BASE_URL", "KAVLA_AI_MODEL"} { t.Setenv(name, "") }
	// API mode must work even when no Codex executable is available.
	t.Setenv("PATH", t.TempDir())
	document, err := OpenDocument(filepath.Join(t.TempDir(), "agent.kavla"))
	if err != nil { t.Fatal(err) }
	s := &Server{document: document}
	t.Cleanup(func() { s.closeCodex(); s.workers.Wait() })
	return s
}

func saveAPIAgentSettings(t *testing.T, s *Server, body string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	s.handleCodexAuth(w, httptest.NewRequest(http.MethodPost, "/api/codex/auth", strings.NewReader(body)))
	return w
}

func awaitAPIAgent(t *testing.T, predicate func() bool) {
	t.Helper()
	deadline := time.Now().Add(3*time.Second)
	for time.Now().Before(deadline) {
		if predicate() { return }
		time.Sleep(time.Millisecond)
	}
	t.Fatal("timed out waiting for Agent state")
}

func TestAPIAgentUsesCanvasToolClaimsAndJournal(t *testing.T) {
	s := newAPIAgentTestServer(t)
	var requests atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) == 1 {
			fmt.Fprint(w, `{"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"note-call","type":"function","function":{"name":"create_note","arguments":"{\"text\":\"hello\"}"}}]}}]}`)
		} else {
			fmt.Fprint(w, `{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Saved [note](shape:note)."}}]}`)
		}
	}))
	defer provider.Close()
	settings, _ := json.Marshal(map[string]interface{}{"mode": "apiKey", "baseUrl": provider.URL, "model": "test-model", "apiKey": "secret-key"})
	if w := saveAPIAgentSettings(t, s, string(settings)); w.Code != http.StatusOK { t.Fatal(w.Body.String()) }
	awaitAPIAgent(t, func() bool { return s.currentCodexStatus().State == "ready" })
	if err := s.startCodexPrompt(codexPromptRequest{RunID: "run-1", ClientID: "owner", DocumentID: s.document.Manifest().DocumentID, Prompt: "Make a note"}); err != nil { t.Fatal(err) }
	awaitAPIAgent(t, func() bool { s.codexMu.Lock(); defer s.codexMu.Unlock(); return len(s.codexRun.Tools) == 1 })
	result := codexToolResultRequest{RunID: "run-1", ClientID: "owner", CallID: "note-call", Success: true, Result: map[string]interface{}{"shapeId": "shape:note"}}
	if err := s.acceptCodexToolResult(result); err == nil { t.Fatal("accepted unclaimed tool result") }
	for i, clientID := range []string{"another-tab", "owner", "owner"} {
		w := httptest.NewRecorder()
		s.handleCodexToolClaim(w, httptest.NewRequest(http.MethodPost, "/api/codex/tool-claims", strings.NewReader(fmt.Sprintf(`{"runId":"run-1","clientId":%q,"callId":"note-call"}`, clientID))))
		var claim struct { Claimed bool `json:"claimed"` }
		if err := json.Unmarshal(w.Body.Bytes(), &claim); err != nil { t.Fatal(err) }
		if claim.Claimed != (i == 1) { t.Fatalf("unexpected claim result on attempt %d: %v", i, claim.Claimed) }
	}
	if w := saveAPIAgentSettings(t, s, `{"mode":"apiKey","model":"other-model"}`); w.Code != http.StatusConflict { t.Fatal("changed provider during a run") }
	if err := s.acceptCodexToolResult(result); err != nil { t.Fatal(err) }
	awaitAPIAgent(t, func() bool { s.codexMu.Lock(); defer s.codexMu.Unlock(); return s.codexRun.Status == "completed" })
	var runs []codexRunState
	if err := json.Unmarshal(s.currentCodexRuns(), &runs); err != nil { t.Fatal(err) }
	if len(runs) != 1 || runs[0].Text != "Saved [note](shape:note)." || runs[0].Tools[0].Status != "completed" { t.Fatalf("unexpected run: %+v", runs) }
	if strings.Contains(string(s.currentCodexRuns()), "secret-key") { t.Fatal("credentials leaked into the run journal") }
	if requests.Load() != 2 { t.Fatal("unexpected repeated model request") }
	s.closeCodex()
	if err := s.loadCodexRuns(); err != nil { t.Fatal(err) }
	if !strings.Contains(string(s.currentCodexRuns()), "Saved [note]") { t.Fatal("run was not persisted") }
}

func TestAPIAuthKeepsCredentialsPrivateAndScopedToEndpoint(t *testing.T) {
	s := newAPIAgentTestServer(t)
	settings := `{"mode":"apiKey","baseUrl":"https://provider.example/v1/","model":"custom-model","apiKey":"session-secret","headers":{"cf-aig-authorization":"Bearer header-secret"}}`
	w := saveAPIAgentSettings(t, s, settings)
	if w.Code != http.StatusOK { t.Fatal(w.Body.String()) }
	awaitAPIAgent(t, func() bool { return s.currentCodexStatus().State == "ready" })
	if strings.Contains(w.Body.String(), "session-secret") || strings.Contains(w.Body.String(), "header-secret") { t.Fatal("credentials exposed to other tabs") }
	if auth := s.currentCodexAuth(); auth["hasHeaders"] != true || auth["baseUrl"] != "https://provider.example/v1" { t.Fatal(auth) }
	if w := saveAPIAgentSettings(t, s, `{"mode":"apiKey","model":"updated-model"}`); w.Code != http.StatusOK { t.Fatal(w.Body.String()) }
	awaitAPIAgent(t, func() bool { return s.currentCodexStatus().State == "ready" })
	s.codexMu.Lock()
	mode, key, source := s.codexAuthLocked()
	s.codexMu.Unlock()
	if mode != "apiKey" || key != "session-secret" || source != "session" || s.currentCodexAuth()["hasHeaders"] != true { t.Fatal("omitted credentials were not retained") }
	if w := saveAPIAgentSettings(t, s, `{"mode":"apiKey","baseUrl":"https://different.example/v1","model":"another-model"}`); w.Code != http.StatusOK { t.Fatal(w.Body.String()) }
	awaitAPIAgent(t, func() bool { return s.currentCodexStatus().State == "ready" })
	if auth := s.currentCodexAuth(); auth["hasApiKey"] != false || auth["hasHeaders"] != false { t.Fatal("credentials carried to another provider", auth) }
	for _, invalid := range []string{
		`{"mode":"apiKey","baseUrl":"file:///tmp/model"}`,
		`{"mode":"apiKey","baseUrl":"https://user:secret@example.com/v1"}`,
		`{"mode":"apiKey","headers":{"X-Test":"bad\r\nheader"}}`,
		`{"mode":"apiKey","headers":{"Content-Type":"text/plain"}}`,
		`{"mode":"apiKey","model":""}`,
	} {
		if w := saveAPIAgentSettings(t, s, invalid); w.Code != http.StatusBadRequest { t.Fatalf("accepted invalid settings: %s", invalid) }
	}
	if w := saveAPIAgentSettings(t, s, settings); w.Code != http.StatusOK { t.Fatal(w.Body.String()) }
	awaitAPIAgent(t, func() bool { return s.currentCodexStatus().State == "ready" })
	if w := saveAPIAgentSettings(t, s, `{"mode":"codex"}`); w.Code != http.StatusOK { t.Fatal(w.Body.String()) }
	awaitAPIAgent(t, func() bool { return s.currentCodexStatus().State == "missing" })
	if auth := s.currentCodexAuth(); auth["mode"] != "codex" || auth["hasApiKey"] != false || auth["hasHeaders"] != false { t.Fatal("Codex login retained API credentials", auth) }
}

func TestAPIAuthEnvironmentCompatibility(t *testing.T) {
	s := newAPIAgentTestServer(t)
	t.Setenv("OPENAI_API_KEY", "openai-secret")
	if auth := s.currentCodexAuth(); auth["mode"] != "apiKey" || auth["baseUrl"] != codex.DefaultAPIBaseURL || auth["keySource"] != "environment" { t.Fatal(auth) }
	t.Setenv("KAVLA_AI_BASE_URL", "https://custom.example/v1")
	t.Setenv("KAVLA_AI_MODEL", "custom-model")
	if auth := s.currentCodexAuth(); auth["hasApiKey"] != false || auth["model"] != "custom-model" { t.Fatal("OpenAI key applied to a different provider", auth) }
	t.Setenv("KAVLA_AI_API_KEY", "custom-secret")
	if key := environmentAPIKey("https://custom.example/v1"); key != "custom-secret" { t.Fatal("custom environment key not applied") }
	if key := environmentAPIKey("https://different.example/v1"); key != "" { t.Fatal("environment key applied to a different endpoint") }
	s.codexAuthMode = "codex"
	if auth := s.currentCodexAuth(); auth["mode"] != "codex" || auth["hasApiKey"] != false { t.Fatal("environment overrides explicit Codex login", auth) }
}
