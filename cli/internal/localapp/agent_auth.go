package localapp

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/aleda145/kavla/cli/internal/agent"
)

// Entered settings are saved in the user's Agent config, never the document or run journal.
// OPENAI_API_KEY supports persistent configuration through the server environment.
// Saved settings take precedence; environment settings provide defaults when missing.
func (s *Server) agentAuthLocked() (mode, key, source string) {
	mode = s.agentAuthMode
	if mode == "codex" {
		return mode, "", ""
	}
	if s.agentAPIKey != "" {
		return "apiKey", s.agentAPIKey, "config"
	}
	if key = environmentAPIKey(s.apiProviderLocked().BaseURL); key != "" {
		return "apiKey", key, "environment"
	}
	if mode == "apiKey" || strings.TrimSpace(os.Getenv("KAVLA_AI_BASE_URL")) != "" {
		return "apiKey", "", ""
	}
	return "codex", "", ""
}

func (s *Server) currentAgentAuth() map[string]interface{} {
	s.agentMu.Lock()
	defer s.agentMu.Unlock()
	mode, key, source := s.agentAuthLocked()
	config := s.apiProviderLocked()
	return map[string]interface{}{"mode": mode, "hasApiKey": key != "", "hasEnvironmentKey": environmentAPIKey(config.BaseURL) != "", "keySource": source, "baseUrl": config.BaseURL, "model": config.Model, "hasHeaders": len(config.Headers) > 0, "maxToolCalls": config.MaxToolCalls}
}

func (s *Server) handleAgentAuth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodGet {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(s.currentAgentAuth())
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	var request struct {
		Mode         string             `json:"mode"`
		APIKey       string             `json:"apiKey"`
		BaseURL      *string            `json:"baseUrl"`
		Model        *string            `json:"model"`
		Headers      *map[string]string `json:"headers"`
		MaxToolCalls *int               `json:"maxToolCalls"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeAPIError(w, 400, fmt.Errorf("invalid Agent authentication settings"))
		return
	}
	if request.Mode != "codex" && request.Mode != "apiKey" {
		writeAPIError(w, 400, fmt.Errorf("choose Codex login or an API provider"))
		return
	}
	key := strings.TrimSpace(request.APIKey)
	s.agentAuthMu.Lock()
	defer s.agentAuthMu.Unlock()
	s.agentMu.Lock()
	if activeAgentRun(s.agentRun) {
		s.agentMu.Unlock()
		writeAPIError(w, 409, fmt.Errorf("stop the current Agent run before changing authentication"))
		return
	}
	config := s.apiProviderLocked()
	if request.MaxToolCalls != nil {
		config.MaxToolCalls = *request.MaxToolCalls
	}
	if err := agent.ValidateMaxToolCalls(config.MaxToolCalls); err != nil {
		s.agentMu.Unlock()
		writeAPIError(w, 400, err)
		return
	}
	previousURL := config.BaseURL
	if request.BaseURL != nil {
		config.BaseURL = strings.TrimRight(strings.TrimSpace(*request.BaseURL), "/")
	}
	if request.Model != nil {
		config.Model = strings.TrimSpace(*request.Model)
	}
	if config.BaseURL != previousURL {
		// Never carry an existing key or secret headers to a newly selected endpoint.
		config.Headers = nil
	} else if key == "" {
		key = s.agentAPIKey
	}
	if request.Headers != nil {
		config.Headers = *request.Headers
	}
	config.APIKey = key
	if request.Mode == "apiKey" {
		if err := config.Validate(); err != nil {
			s.agentMu.Unlock()
			writeAPIError(w, 400, err)
			return
		}
	} else {
		key, config.APIKey, config.Headers = "", "", nil
	}
	if err := s.saveAgentConfig(request.Mode, config); err != nil {
		s.agentMu.Unlock()
		writeAPIError(w, 500, err)
		return
	}
	// Prevent a prompt from starting between changing credentials and restarting the agent.
	s.agentAuthChanging = true
	s.agentAuthMode = request.Mode
	s.agentAPIKey = key
	config.APIKey = ""
	s.apiProvider = config
	if request.Mode == "codex" {
		s.agentAPIKey = ""
		s.apiProvider.Headers = nil
	}
	s.agentMu.Unlock()
	s.retryAgentDetection()
	s.agentMu.Lock()
	s.agentAuthChanging = false
	s.agentMu.Unlock()
	settings := s.currentAgentAuth()
	s.broadcastAgentRuntimeEvent(cliRuntimeEvent{name: "auth", data: settings})
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(settings)
}

func environmentAPIBaseURL() string {
	baseURL := strings.TrimSpace(os.Getenv("KAVLA_AI_BASE_URL"))
	if baseURL == "" {
		baseURL = strings.TrimSpace(os.Getenv("OPENAI_BASE_URL"))
	}
	if baseURL == "" {
		baseURL = agent.DefaultAPIBaseURL
	}
	return strings.TrimRight(baseURL, "/")
}

func environmentAPIKey(baseURL string) string {
	if baseURL == environmentAPIBaseURL() {
		if key := strings.TrimSpace(os.Getenv("KAVLA_AI_API_KEY")); key != "" {
			return key
		}
	}
	openAIURL := strings.TrimRight(strings.TrimSpace(os.Getenv("OPENAI_BASE_URL")), "/")
	if openAIURL == "" {
		openAIURL = agent.DefaultAPIBaseURL
	}
	if baseURL == openAIURL {
		return strings.TrimSpace(os.Getenv("OPENAI_API_KEY"))
	}
	return ""
}

// Caller holds agentMu. Headers are replaced as a whole and never mutated.
func (s *Server) apiProviderLocked() agent.APIConfig {
	return withAPIProviderDefaults(s.apiProvider)
}

func withAPIProviderDefaults(config agent.APIConfig) agent.APIConfig {
	config.MaxToolCalls = agent.MaxToolCallsOrDefault(config.MaxToolCalls)
	if config.BaseURL == "" {
		config.BaseURL = environmentAPIBaseURL()
	}
	if config.Model == "" {
		config.Model = strings.TrimSpace(os.Getenv("KAVLA_AI_MODEL"))
	}
	if config.Model == "" {
		config.Model = agent.DefaultAPIModel
	}
	return config
}
