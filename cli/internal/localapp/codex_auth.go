package localapp

import (
 "encoding/json"
 "fmt"
 "net/http"
 "os"
 "strings"
 "unicode"
)

// The UI key belongs to this server process, never the document or run journal.
// OPENAI_API_KEY supports persistent configuration through the server environment.
func (s *Server) codexAuthLocked() (mode, key, source string) {
 mode = s.codexAuthMode
 if mode == "codex" { return mode, "", "" }
 if s.codexAPIKey != "" { return "apiKey", s.codexAPIKey, "session" }
 if key = strings.TrimSpace(os.Getenv("OPENAI_API_KEY")); key != "" { return "apiKey", key, "environment" }
 if mode == "apiKey" { return mode, "", "" }
 return "codex", "", ""
}

func (s *Server) currentCodexAuth() map[string]interface{} {
 s.codexMu.Lock()
 defer s.codexMu.Unlock()
 mode, key, source := s.codexAuthLocked()
 return map[string]interface{}{"mode": mode, "hasApiKey": key != "", "hasEnvironmentKey": strings.TrimSpace(os.Getenv("OPENAI_API_KEY")) != "", "keySource": source}
}

func (s *Server) handleCodexAuth(w http.ResponseWriter, r *http.Request) {
 w.Header().Set("Cache-Control", "no-store")
 if r.Method == http.MethodGet {
  w.Header().Set("Content-Type", "application/json")
  _ = json.NewEncoder(w).Encode(s.currentCodexAuth())
  return
 }
 r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
 var request struct { Mode string `json:"mode"`; APIKey string `json:"apiKey"` }
 if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
  writeAPIError(w, 400, fmt.Errorf("invalid Agent authentication settings")); return
 }
 if request.Mode != "codex" && request.Mode != "apiKey" {
  writeAPIError(w, 400, fmt.Errorf("choose Codex login or an OpenAI API key")); return
 }
 key := strings.TrimSpace(request.APIKey)
 if len(key) > 8192 || strings.IndexFunc(key, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0 {
  writeAPIError(w, 400, fmt.Errorf("the API key contains invalid characters")); return
 }
 s.codexAuthMu.Lock()
 defer s.codexAuthMu.Unlock()
 s.codexMu.Lock()
 if activeCodexRun(s.codexRun) {
  s.codexMu.Unlock(); writeAPIError(w, 409, fmt.Errorf("stop the current Agent run before changing authentication")); return
 }
 if request.Mode == "apiKey" && key == "" {
  key = s.codexAPIKey
  if key == "" && strings.TrimSpace(os.Getenv("OPENAI_API_KEY")) == "" {
   s.codexMu.Unlock(); writeAPIError(w, 400, fmt.Errorf("enter an OpenAI API key or set OPENAI_API_KEY on the server")); return
  }
 }
 // Prevent a prompt from starting between changing credentials and restarting Codex.
 s.codexAuthChanging = true
 s.codexAuthMode = request.Mode
 s.codexAPIKey = key
 if request.Mode == "codex" { s.codexAPIKey = "" }
 s.codexMu.Unlock()
 s.retryCodexDetection()
 s.codexMu.Lock()
 s.codexAuthChanging = false
 s.codexMu.Unlock()
 settings := s.currentCodexAuth()
 s.broadcastCodexRuntimeEvent(cliRuntimeEvent{name: "auth", data: settings})
 w.Header().Set("Content-Type", "application/json")
 _ = json.NewEncoder(w).Encode(settings)
}
