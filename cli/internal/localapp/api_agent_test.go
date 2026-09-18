package localapp

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aleda145/kavla/cli/internal/agent"
)

func newAPIAgentTestServer(t *testing.T) *Server {
	t.Helper()
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	for _, name := range []string{"OPENAI_API_KEY", "OPENAI_BASE_URL", "KAVLA_AI_API_KEY", "KAVLA_AI_BASE_URL", "KAVLA_AI_MODEL"} { t.Setenv(name, "") }
	// API mode must work even when no Codex executable is available.
	t.Setenv("PATH", t.TempDir())
	document, err := OpenDocument(filepath.Join(t.TempDir(), "agent.kavla"))
	if err != nil { t.Fatal(err) }
	s := &Server{document: document, agentConfigPath: filepath.Join(t.TempDir(), "agent.yaml")}
	t.Cleanup(func() { s.closeAgent(); s.workers.Wait() })
	return s
}

func saveAPIAgentSettings(t *testing.T, s *Server, body string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	s.handleAgentAuth(w, httptest.NewRequest(http.MethodPost, "/api/agent/auth", strings.NewReader(body)))
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
	awaitAPIAgent(t, func() bool { return s.currentAgentStatus().State == "ready" })
	if err := s.startAgentPrompt(agentPromptRequest{RunID: "run-1", ClientID: "owner", DocumentID: s.document.Manifest().DocumentID, Prompt: "Make a note"}); err != nil { t.Fatal(err) }
	awaitAPIAgent(t, func() bool { s.agentMu.Lock(); defer s.agentMu.Unlock(); return len(s.agentRun.Tools) == 1 })
	result := agentToolResultRequest{RunID: "run-1", ClientID: "owner", CallID: "note-call", Success: true, Result: map[string]interface{}{"shapeId": "shape:note"}}
	if err := s.acceptAgentToolResult(result); err == nil { t.Fatal("accepted unclaimed tool result") }
	for i, clientID := range []string{"another-tab", "owner", "owner"} {
		w := httptest.NewRecorder()
		s.handleAgentToolClaim(w, httptest.NewRequest(http.MethodPost, "/api/agent/tool-claims", strings.NewReader(fmt.Sprintf(`{"runId":"run-1","clientId":%q,"callId":"note-call"}`, clientID))))
		var claim struct { Claimed bool `json:"claimed"` }
		if err := json.Unmarshal(w.Body.Bytes(), &claim); err != nil { t.Fatal(err) }
		if claim.Claimed != (i == 1) { t.Fatalf("unexpected claim result on attempt %d: %v", i, claim.Claimed) }
	}
	if w := saveAPIAgentSettings(t, s, `{"mode":"apiKey","model":"other-model"}`); w.Code != http.StatusConflict { t.Fatal("changed provider during a run") }
	if err := s.acceptAgentToolResult(result); err != nil { t.Fatal(err) }
	awaitAPIAgent(t, func() bool { s.agentMu.Lock(); defer s.agentMu.Unlock(); return s.agentRun.Status == "completed" })
	var runs []agentRunState
	if err := json.Unmarshal(s.currentAgentRuns(), &runs); err != nil { t.Fatal(err) }
	if len(runs) != 1 || runs[0].Text != "Saved [note](shape:note)." || runs[0].Tools[0].Status != "completed" { t.Fatalf("unexpected run: %+v", runs) }
	if strings.Contains(string(s.currentAgentRuns()), "secret-key") { t.Fatal("credentials leaked into the run journal") }
	if requests.Load() != 2 { t.Fatal("unexpected repeated model request") }
	s.closeAgent()
	if err := s.loadAgentRuns(); err != nil { t.Fatal(err) }
	if !strings.Contains(string(s.currentAgentRuns()), "Saved [note]") { t.Fatal("run was not persisted") }
}

func TestAPIAuthKeepsCredentialsPrivateAndScopedToEndpoint(t *testing.T) {
	s := newAPIAgentTestServer(t)
	settings := `{"mode":"apiKey","baseUrl":"https://provider.example/v1/","model":"custom-model","apiKey":"session-secret","headers":{"cf-aig-authorization":"Bearer header-secret"}}`
	w := saveAPIAgentSettings(t, s, settings)
	if w.Code != http.StatusOK { t.Fatal(w.Body.String()) }
	awaitAPIAgent(t, func() bool { return s.currentAgentStatus().State == "ready" })
	if strings.Contains(w.Body.String(), "session-secret") || strings.Contains(w.Body.String(), "header-secret") { t.Fatal("credentials exposed to other tabs") }
	if auth := s.currentAgentAuth(); auth["hasHeaders"] != true || auth["baseUrl"] != "https://provider.example/v1" { t.Fatal(auth) }
	if w := saveAPIAgentSettings(t, s, `{"mode":"apiKey","model":"updated-model"}`); w.Code != http.StatusOK { t.Fatal(w.Body.String()) }
	awaitAPIAgent(t, func() bool { return s.currentAgentStatus().State == "ready" })
	s.agentMu.Lock()
	mode, key, source := s.agentAuthLocked()
	s.agentMu.Unlock()
	if mode != "apiKey" || key != "session-secret" || source != "config" || s.currentAgentAuth()["hasHeaders"] != true { t.Fatal("omitted credentials were not retained") }
	if w := saveAPIAgentSettings(t, s, `{"mode":"apiKey","baseUrl":"https://different.example/v1","model":"another-model"}`); w.Code != http.StatusOK { t.Fatal(w.Body.String()) }
	awaitAPIAgent(t, func() bool { return s.currentAgentStatus().State == "ready" })
	if auth := s.currentAgentAuth(); auth["hasApiKey"] != false || auth["hasHeaders"] != false { t.Fatal("credentials carried to another provider", auth) }
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
	awaitAPIAgent(t, func() bool { return s.currentAgentStatus().State == "ready" })
	if w := saveAPIAgentSettings(t, s, `{"mode":"codex"}`); w.Code != http.StatusOK { t.Fatal(w.Body.String()) }
	awaitAPIAgent(t, func() bool { return s.currentAgentStatus().State == "missing" })
	if auth := s.currentAgentAuth(); auth["mode"] != "codex" || auth["hasApiKey"] != false || auth["hasHeaders"] != false { t.Fatal("Codex login retained API credentials", auth) }
}

func TestAPIAuthEnvironmentCompatibility(t *testing.T) {
	s := newAPIAgentTestServer(t)
	t.Setenv("OPENAI_API_KEY", "openai-secret")
	if auth := s.currentAgentAuth(); auth["mode"] != "apiKey" || auth["baseUrl"] != agent.DefaultAPIBaseURL || auth["keySource"] != "environment" { t.Fatal(auth) }
	t.Setenv("KAVLA_AI_BASE_URL", "https://custom.example/v1")
	t.Setenv("KAVLA_AI_MODEL", "custom-model")
	if auth := s.currentAgentAuth(); auth["hasApiKey"] != false || auth["model"] != "custom-model" { t.Fatal("OpenAI key applied to a different provider", auth) }
	t.Setenv("KAVLA_AI_API_KEY", "custom-secret")
	if key := environmentAPIKey("https://custom.example/v1"); key != "custom-secret" { t.Fatal("custom environment key not applied") }
	if key := environmentAPIKey("https://different.example/v1"); key != "" { t.Fatal("environment key applied to a different endpoint") }
	s.agentAuthMode = "codex"
	if auth := s.currentAgentAuth(); auth["mode"] != "codex" || auth["hasApiKey"] != false { t.Fatal("environment overrides explicit Codex login", auth) }
}

func TestAgentConfigRestoresSettingsAfterRestart(t *testing.T) {
	s := newAPIAgentTestServer(t)
	if w := saveAPIAgentSettings(t, s, `{"mode":"apiKey","baseUrl":"https://provider.example/v1","model":"custom-model","apiKey":"saved-secret","headers":{"cf-aig-authorization":"Bearer saved-header"},"maxToolCalls":75}`); w.Code != http.StatusOK { t.Fatal(w.Body.String()) }
	awaitAPIAgent(t, func() bool { return s.currentAgentStatus().State == "ready" })
	s.closeAgent()
	info, err := os.Stat(s.agentConfigPath)
	if err != nil { t.Fatal(err) }
	if info.Mode().Perm() != 0600 { t.Fatalf("expected owner-only permissions, got %o", info.Mode().Perm()) }
	t.Setenv("KAVLA_AI_BASE_URL", "https://environment.example/v1")
	t.Setenv("KAVLA_AI_MODEL", "environment-model")
	t.Setenv("KAVLA_AI_API_KEY", "environment-key")
	restarted := &Server{agentConfigPath: s.agentConfigPath}
	if err := restarted.loadAgentConfig(); err != nil { t.Fatal(err) }
	if restarted.agentAPIKey != "saved-secret" || restarted.apiProvider.Headers["cf-aig-authorization"] != "Bearer saved-header" { t.Fatal("credentials not restored") }
	auth := restarted.currentAgentAuth()
	if auth["mode"] != "apiKey" || auth["baseUrl"] != "https://provider.example/v1" || auth["model"] != "custom-model" || auth["keySource"] != "config" || auth["maxToolCalls"] != 75 { t.Fatal(auth) }
	if w := saveAPIAgentSettings(t, s, `{"mode":"codex"}`); w.Code != http.StatusOK { t.Fatal(w.Body.String()) }
	if err := restarted.loadAgentConfig(); err != nil { t.Fatal(err) }
	if auth := restarted.currentAgentAuth(); auth["mode"] != "codex" || auth["hasApiKey"] != false || auth["hasHeaders"] != false || auth["maxToolCalls"] != 75 { t.Fatal("Codex login selection not persisted", auth) }
	data, err := os.ReadFile(s.agentConfigPath)
	if err != nil { t.Fatal(err) }
	if strings.Contains(string(data), "saved-secret") || strings.Contains(string(data), "saved-header") { t.Fatal("discarded credentials remain in config") }
}

func TestAgentConfigWriteFailureLeavesConnectionUnchanged(t *testing.T) {
	s := newAPIAgentTestServer(t)
	if w := saveAPIAgentSettings(t, s, `{"mode":"apiKey","baseUrl":"https://provider.example/v1","model":"original-model","apiKey":"original-key"}`); w.Code != http.StatusOK { t.Fatal(w.Body.String()) }
	awaitAPIAgent(t, func() bool { return s.currentAgentStatus().State == "ready" })
	originalPath := s.agentConfigPath
	before, err := os.ReadFile(originalPath)
	if err != nil { t.Fatal(err) }
	// A regular file cannot serve as a parent directory, regardless of user privileges.
	s.agentConfigPath = filepath.Join(originalPath, "agent.yaml")
	if w := saveAPIAgentSettings(t, s, `{"mode":"apiKey","model":"replacement-model","apiKey":"replacement-key"}`); w.Code != http.StatusInternalServerError { t.Fatalf("expected save failure: %s", w.Body.String()) }
	if auth := s.currentAgentAuth(); auth["model"] != "original-model" { t.Fatal("failed save changed the connection", auth) }
	s.agentMu.Lock()
	key, changing := s.agentAPIKey, s.agentAuthChanging
	s.agentMu.Unlock()
	if key != "original-key" || changing { t.Fatal("failed save changed credentials or left the connection locked") }
	after, err := os.ReadFile(originalPath)
	if err != nil { t.Fatal(err) }
	if string(before) != string(after) { t.Fatal("failed save changed the existing config") }
}

func TestAgentConfigMissingAndInvalidFiles(t *testing.T) {
	s := newAPIAgentTestServer(t)
	if err := s.loadAgentConfig(); err != nil { t.Fatalf("missing config should use defaults: %v", err) }
	for _, data := range []string{"invalid: [", "mode: unsupported\n", "mode: apiKey\nbase_url: file:///tmp/model\nmodel: test\n"} {
		if err := os.WriteFile(s.agentConfigPath, []byte(data), 0600); err != nil { t.Fatal(err) }
		if err := s.loadAgentConfig(); err == nil { t.Fatalf("accepted invalid Agent config: %s", data) }
	}
}

func TestAgentConfigUsesEnvironmentDefaultsWithoutSavingEnvironmentKey(t *testing.T) {
	s := newAPIAgentTestServer(t)
	t.Setenv("KAVLA_AI_BASE_URL", "https://environment.example/v1")
	t.Setenv("KAVLA_AI_MODEL", "environment-model")
	t.Setenv("KAVLA_AI_API_KEY", "environment-secret")
	if err := os.WriteFile(s.agentConfigPath, []byte("mode: apiKey\n"), 0600); err != nil { t.Fatal(err) }
	if err := s.loadAgentConfig(); err != nil { t.Fatal(err) }
	if auth := s.currentAgentAuth(); auth["baseUrl"] != "https://environment.example/v1" || auth["model"] != "environment-model" || auth["keySource"] != "environment" { t.Fatal(auth) }
	if w := saveAPIAgentSettings(t, s, `{"mode":"apiKey","model":"saved-model"}`); w.Code != http.StatusOK { t.Fatal(w.Body.String()) }
	data, err := os.ReadFile(s.agentConfigPath)
	if err != nil { t.Fatal(err) }
	if strings.Contains(string(data), "environment-secret") { t.Fatal("environment key copied into config") }
}
