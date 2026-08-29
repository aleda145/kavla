package cmd

import (
	"os"
	"path/filepath"
	"testing"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
)

func TestRunAddSourceDoesNotOverwriteMalformedConfig(t *testing.T) {
	resetSourceFlags()
	defer resetSourceFlags()
	t.Setenv("HOME", t.TempDir())

	path, err := kavlaconfig.GetConfigPath()
	if err != nil {
		t.Fatalf("GetConfigPath returned error: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}

	badConfig := "token: [\n"
	if err := os.WriteFile(path, []byte(badConfig), 0o600); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	sourceType = "bigquery"
	sourceName = "analytics"
	sourceConnection = "my-project"

	if err := runAddSourceWithPrompter(&fakeSourcePrompter{}, false); err == nil {
		t.Fatal("expected add-source to fail on malformed config")
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile returned error: %v", err)
	}
	if string(data) != badConfig {
		t.Fatalf("expected malformed config to remain unchanged, got %q", string(data))
	}
}
