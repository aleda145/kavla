package localapp

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/aleda145/kavla/cli/internal/codex"
	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
	"gopkg.in/yaml.v3"
)

type agentConfig struct {
	Mode string `yaml:"mode"`
	BaseURL string `yaml:"base_url,omitempty"`
	Model string `yaml:"model,omitempty"`
	APIKey string `yaml:"api_key,omitempty"`
	Headers map[string]string `yaml:"headers,omitempty"`
}

func (s *Server) agentConfigFilePath() (string, error) {
	if s.agentConfigPath != "" { return s.agentConfigPath, nil }
	path, err := kavlaconfig.GetConfigPath()
	if err != nil { return "", err }
	return filepath.Join(filepath.Dir(path), "agent.yaml"), nil
}

func (s *Server) loadAgentConfig() error {
	path, err := s.agentConfigFilePath()
	if err != nil { return fmt.Errorf("locate Agent config: %w", err) }
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) { return nil }
	if err != nil { return fmt.Errorf("read Agent config %s: %w", path, err) }
	var saved agentConfig
	if err := yaml.Unmarshal(data, &saved); err != nil { return fmt.Errorf("invalid Agent config in %s: %w", path, err) }
	if saved.Mode != "codex" && saved.Mode != "apiKey" { return fmt.Errorf("Agent config %s must select mode codex or apiKey", path) }
	provider := withAPIProviderDefaults(codex.APIConfig{BaseURL: saved.BaseURL, Model: saved.Model, APIKey: saved.APIKey, Headers: saved.Headers})
	if saved.Mode == "apiKey" {
		if err := provider.Validate(); err != nil { return fmt.Errorf("invalid Agent config %s: %w", path, err) }
	} else {
		provider.APIKey, provider.Headers = "", nil
	}
	s.codexMu.Lock()
	s.codexAuthMode, s.codexAPIKey = saved.Mode, provider.APIKey
	provider.APIKey = ""
	s.apiProvider = provider
	s.codexMu.Unlock()
	return nil
}

func (s *Server) saveAgentConfig(mode string, provider codex.APIConfig) error {
	path, err := s.agentConfigFilePath()
	if err != nil { return fmt.Errorf("locate Agent config: %w", err) }
	data, err := yaml.Marshal(agentConfig{Mode: mode, BaseURL: provider.BaseURL, Model: provider.Model, APIKey: provider.APIKey, Headers: provider.Headers})
	if err != nil { return fmt.Errorf("encode Agent config: %w", err) }
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil { return fmt.Errorf("create Agent config directory: %w", err) }
	if err := atomicWriteFile(path, data, 0600); err != nil { return fmt.Errorf("save Agent config %s: %w", path, err) }
	return nil
}
