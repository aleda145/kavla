package localapp

import (
 "encoding/json"
 "fmt"
 "net/http"
 "os"
 "strings"

 "github.com/aleda145/kavla/cli/internal/codex"
)

// Entered settings are saved in the user's Agent config, never the document or run journal.
// OPENAI_API_KEY supports persistent configuration through the server environment.
// Saved settings take precedence; environment settings provide defaults when missing.
func (s *Server) codexAuthLocked() (mode, key, source string) {
 mode = s.codexAuthMode
 if mode == "codex" { return mode, "", "" }
 if s.codexAPIKey != "" { return "apiKey", s.codexAPIKey, "config" }
 if key = environmentAPIKey(s.apiProviderLocked().BaseURL); key != "" { return "apiKey", key, "environment" }
 if mode == "apiKey" || strings.TrimSpace(os.Getenv("KAVLA_AI_BASE_URL")) != "" { return "apiKey", "", "" }
 return "codex", "", ""
}

func (s *Server) currentCodexAuth() map[string]interface{} {
 s.codexMu.Lock()
 defer s.codexMu.Unlock()
 mode, key, source := s.codexAuthLocked()
 config := s.apiProviderLocked()
 return map[string]interface{}{"mode": mode, "hasApiKey": key != "", "hasEnvironmentKey": environmentAPIKey(config.BaseURL) != "", "keySource": source, "baseUrl": config.BaseURL, "model": config.Model, "hasHeaders": len(config.Headers) > 0}
}

func (s *Server) handleCodexAuth(w http.ResponseWriter, r *http.Request) {
 w.Header().Set("Cache-Control", "no-store")
 if r.Method == http.MethodGet {
  w.Header().Set("Content-Type", "application/json")
  _ = json.NewEncoder(w).Encode(s.currentCodexAuth())
  return
 }
 r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
 var request struct { Mode string `json:"mode"`; APIKey string `json:"apiKey"`; BaseURL *string `json:"baseUrl"`; Model *string `json:"model"`; Headers *map[string]string `json:"headers"` }
 if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
  writeAPIError(w, 400, fmt.Errorf("invalid Agent authentication settings")); return
 }
 if request.Mode != "codex" && request.Mode != "apiKey" {
  writeAPIError(w, 400, fmt.Errorf("choose Codex login or an API provider")); return
 }
 key := strings.TrimSpace(request.APIKey)
 s.codexAuthMu.Lock()
 defer s.codexAuthMu.Unlock()
 s.codexMu.Lock()
 if activeCodexRun(s.codexRun) {
  s.codexMu.Unlock(); writeAPIError(w, 409, fmt.Errorf("stop the current Agent run before changing authentication")); return
 }
 config := s.apiProviderLocked()
 previousURL := config.BaseURL
 if request.BaseURL != nil { config.BaseURL = strings.TrimRight(strings.TrimSpace(*request.BaseURL), "/") }
 if request.Model != nil { config.Model = strings.TrimSpace(*request.Model) }
 if config.BaseURL != previousURL {
  // Never carry an existing key or secret headers to a newly selected endpoint.
  config.Headers = nil
 } else if key == "" { key = s.codexAPIKey }
 if request.Headers != nil { config.Headers = *request.Headers }
 config.APIKey = key
 if request.Mode == "apiKey" {
  if err := config.Validate(); err != nil { s.codexMu.Unlock(); writeAPIError(w, 400, err); return }
 } else {
  key, config.APIKey, config.Headers = "", "", nil
 }
 if err := s.saveAgentConfig(request.Mode, config); err != nil { s.codexMu.Unlock(); writeAPIError(w, 500, err); return }
 // Prevent a prompt from starting between changing credentials and restarting Codex.
 s.codexAuthChanging = true
 s.codexAuthMode = request.Mode
 s.codexAPIKey = key
 config.APIKey = ""
 s.apiProvider = config
 if request.Mode == "codex" { s.codexAPIKey = ""; s.apiProvider.Headers = nil }
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

func environmentAPIBaseURL() string {
 baseURL := strings.TrimSpace(os.Getenv("KAVLA_AI_BASE_URL"))
 if baseURL == "" { baseURL = strings.TrimSpace(os.Getenv("OPENAI_BASE_URL")) }
 if baseURL == "" { baseURL = codex.DefaultAPIBaseURL }
 return strings.TrimRight(baseURL, "/")
}

func environmentAPIKey(baseURL string) string {
 if baseURL == environmentAPIBaseURL() {
  if key := strings.TrimSpace(os.Getenv("KAVLA_AI_API_KEY")); key != "" { return key }
 }
 openAIURL := strings.TrimRight(strings.TrimSpace(os.Getenv("OPENAI_BASE_URL")), "/")
 if openAIURL == "" { openAIURL = codex.DefaultAPIBaseURL }
 if baseURL == openAIURL { return strings.TrimSpace(os.Getenv("OPENAI_API_KEY")) }
 return ""
}

// Caller holds codexMu. Headers are replaced as a whole and never mutated.
func (s *Server) apiProviderLocked() codex.APIConfig {
 return withAPIProviderDefaults(s.apiProvider)
}

func withAPIProviderDefaults(config codex.APIConfig) codex.APIConfig {
 if config.BaseURL == "" { config.BaseURL = environmentAPIBaseURL() }
 if config.Model == "" { config.Model = strings.TrimSpace(os.Getenv("KAVLA_AI_MODEL")) }
 if config.Model == "" { config.Model = codex.DefaultAPIModel }
 return config
}
