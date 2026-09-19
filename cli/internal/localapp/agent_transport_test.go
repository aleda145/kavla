package localapp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"nhooyr.io/websocket"
	"nhooyr.io/websocket/wsjson"
)

func TestAgentRoutesAndRuntimeStream(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	fixture := newAPIAgentTestServer(t)
	s, err := NewServer(fixture.document, fstest.MapFS{"index.html": {Data: []byte("ok")}}, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close(context.Background()) })
	awaitAPIAgent(t, func() bool { return s.currentAgentStatus().State == "missing" })

	auth := httptest.NewRecorder()
	s.routes().ServeHTTP(auth, httptest.NewRequest(http.MethodGet, "/api/agent/auth", nil))
	if auth.Code != http.StatusOK {
		t.Fatalf("auth route: %d %s", auth.Code, auth.Body.String())
	}
	var settings map[string]interface{}
	if err := json.Unmarshal(auth.Body.Bytes(), &settings); err != nil {
		t.Fatal(err)
	}
	if settings["mode"] != "codex" {
		t.Fatalf("unexpected provider mode: %v", settings)
	}

	server := httptest.NewServer(s.routes())
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	connection, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/runtime/events", &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{server.URL}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer connection.CloseNow()

	for _, stream := range []string{"cli", "agent"} {
		var event runtimeSocketEvent
		if err := wsjson.Read(ctx, connection, &event); err != nil {
			t.Fatal(err)
		}
		if event.Stream != stream || event.Name != "snapshot" {
			t.Fatalf("expected %s snapshot, got %+v", stream, event)
		}
	}
	s.broadcastAgentRuntimeEvent(cliRuntimeEvent{name: "status", data: map[string]string{"state": "ready", "message": "Connected"}})
	var event runtimeSocketEvent
	if err := wsjson.Read(ctx, connection, &event); err != nil {
		t.Fatal(err)
	}
	if event.Stream != "agent" || event.Name != "status" {
		t.Fatalf("expected agent status, got %+v", event)
	}

	request := httptest.NewRequest(http.MethodPost, "/api/agent/cancel", strings.NewReader(`{"runId":"finished-run"}`))
	request.Header.Set("Origin", "http://example.com")
	response := httptest.NewRecorder()
	s.routes().ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("cancel route: %d %s", response.Code, response.Body.String())
	}
}
