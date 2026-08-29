package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadConfigAllowMissingReturnsEmptyConfigWhenFileIsMissing(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	config, err := LoadConfigAllowMissing()
	if err != nil {
		t.Fatalf("LoadConfigAllowMissing returned error: %v", err)
	}
	if config == nil {
		t.Fatal("expected config, got nil")
	}
	if len(config.Sources) != 0 {
		t.Fatalf("expected empty config, got %#v", config)
	}
}

func TestSaveConfigTightensExistingFilePermissions(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	path, err := GetConfigPath()
	if err != nil {
		t.Fatalf("GetConfigPath returned error: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}
	if err := os.WriteFile(path, []byte("sources: {}\n"), 0644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}
	if err := SaveConfig(&Config{}); err != nil {
		t.Fatalf("SaveConfig returned error: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat returned error: %v", err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("expected config permissions 0600, got %o", info.Mode().Perm())
	}
}
