package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

type SourceConfig struct {
	Type       string `yaml:"type"`
	Connection string `yaml:"connection"`
}

type Config struct {
	Token        string                  `yaml:"token,omitempty"`
	APIURL       string                  `yaml:"api_url,omitempty"`
	AuthURL      string                  `yaml:"auth_url,omitempty"`
	AppURL       string                  `yaml:"app_url,omitempty"`
	LastDocument string                  `yaml:"last_document,omitempty"`
	Sources      map[string]SourceConfig `yaml:"sources,omitempty"`
}

func RememberDocumentPath(documentPath string) error {
	documentPath = strings.TrimSpace(documentPath)
	if documentPath == "" {
		return fmt.Errorf("document path is required")
	}
	absPath, err := filepath.Abs(documentPath)
	if err != nil {
		return fmt.Errorf("resolve document path: %w", err)
	}
	if !strings.EqualFold(filepath.Ext(absPath), ".kavla") {
		return fmt.Errorf("Kavla documents must use the .kavla extension")
	}
	config, err := LoadConfigAllowMissing()
	if err != nil {
		return err
	}
	config.LastDocument = filepath.Clean(absPath)
	return SaveConfig(config)
}

func GetConfigPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".kavla", "config.yaml"), nil
}

func SaveConfig(config *Config) error {
	path, err := GetConfigPath()
	if err != nil {
		return err
	}

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return err
	}

	data, err := yaml.Marshal(config)
	if err != nil {
		return err
	}

	if err := os.WriteFile(path, data, 0600); err != nil {
		return err
	}
	return os.Chmod(path, 0600)
}

func LoadConfigAllowMissing() (*Config, error) {
	config, err := LoadConfig()
	if err == nil {
		return config, nil
	}
	if os.IsNotExist(err) {
		return &Config{}, nil
	}
	return nil, err
}

func IsConfigMissing(err error) bool {
	return os.IsNotExist(err)
}

func LoadConfig() (*Config, error) {
	path, err := GetConfigPath()
	if err != nil {
		return nil, err
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var config Config
	if err := yaml.Unmarshal(data, &config); err != nil {
		return nil, err
	}

	return &config, nil
}
