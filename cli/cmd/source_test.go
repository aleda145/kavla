package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
)

type fakeSourcePrompter struct {
	selectAnswers []string
	inputAnswers  []string
}

func (f *fakeSourcePrompter) Select(label string, options []sourcePromptOption) (string, error) {
	if len(f.selectAnswers) == 0 {
		return "", errPromptCancelled
	}
	answer := f.selectAnswers[0]
	f.selectAnswers = f.selectAnswers[1:]
	return answer, nil
}

func (f *fakeSourcePrompter) Input(label, help string) (string, error) {
	if len(f.inputAnswers) == 0 {
		return "", errPromptCancelled
	}
	answer := f.inputAnswers[0]
	f.inputAnswers = f.inputAnswers[1:]
	return answer, nil
}

func resetSourceFlags() {
	sourceName = ""
	sourceType = ""
	sourceConnection = ""
}

func loadSavedConfig(t *testing.T) *kavlaconfig.Config {
	t.Helper()
	config, err := kavlaconfig.LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig returned error: %v", err)
	}
	return config
}

func TestRunAddSourceInteractivePromptsAndSavesConfig(t *testing.T) {
	resetSourceFlags()
	defer resetSourceFlags()
	t.Setenv("HOME", t.TempDir())

	prompter := &fakeSourcePrompter{
		selectAnswers: []string{"bigquery"},
		inputAnswers:  []string{"analytics", "my-project"},
	}

	if err := runAddSourceWithPrompter(prompter, true); err != nil {
		t.Fatalf("runAddSourceWithPrompter returned error: %v", err)
	}

	config := loadSavedConfig(t)
	source, ok := config.Sources["analytics"]
	if !ok {
		t.Fatalf("expected saved source named analytics, got %#v", config.Sources)
	}
	if source.Type != "bigquery" {
		t.Fatalf("expected type bigquery, got %q", source.Type)
	}
	if source.Connection != "my-project" {
		t.Fatalf("expected project ID connection, got %q", source.Connection)
	}
}

func TestRunAddSourceInteractivePromptsAndSavesPostgresConfig(t *testing.T) {
	resetSourceFlags()
	defer resetSourceFlags()
	t.Setenv("HOME", t.TempDir())

	prompter := &fakeSourcePrompter{
		selectAnswers: []string{"postgres"},
		inputAnswers:  []string{"warehouse", "postgres://user:password@localhost:5432/analytics?sslmode=require"},
	}

	if err := runAddSourceWithPrompter(prompter, true); err != nil {
		t.Fatalf("runAddSourceWithPrompter returned error: %v", err)
	}

	config := loadSavedConfig(t)
	source, ok := config.Sources["warehouse"]
	if !ok {
		t.Fatalf("expected saved source named warehouse, got %#v", config.Sources)
	}
	if source.Type != "postgres" {
		t.Fatalf("expected type postgres, got %q", source.Type)
	}
	if source.Connection != "postgres://user:password@localhost:5432/analytics?sslmode=require" {
		t.Fatalf("unexpected postgres connection %q", source.Connection)
	}
}

func TestRunAddSourcePartialFlagsOnlyPromptsForMissingValues(t *testing.T) {
	resetSourceFlags()
	defer resetSourceFlags()
	t.Setenv("HOME", t.TempDir())

	sourceType = "bigquery"
	sourceName = "analytics"

	prompter := &fakeSourcePrompter{inputAnswers: []string{"my-project"}}
	if err := runAddSourceWithPrompter(prompter, true); err != nil {
		t.Fatalf("runAddSourceWithPrompter returned error: %v", err)
	}

	config := loadSavedConfig(t)
	if got := config.Sources["analytics"].Connection; got != "my-project" {
		t.Fatalf("expected prompted connection to be saved, got %q", got)
	}
	if len(prompter.selectAnswers) != 0 {
		t.Fatalf("expected no select prompts, got leftover answers %#v", prompter.selectAnswers)
	}
}

func TestRunAddSourcePostgresTrimsProvidedConnection(t *testing.T) {
	resetSourceFlags()
	defer resetSourceFlags()
	t.Setenv("HOME", t.TempDir())

	sourceType = "postgres"
	sourceName = "warehouse"
	sourceConnection = "  postgres://user:password@localhost:5432/analytics  "

	if err := runAddSourceWithPrompter(&fakeSourcePrompter{}, false); err != nil {
		t.Fatalf("runAddSourceWithPrompter returned error: %v", err)
	}

	config := loadSavedConfig(t)
	if got := config.Sources["warehouse"].Connection; got != "postgres://user:password@localhost:5432/analytics" {
		t.Fatalf("expected trimmed postgres connection, got %q", got)
	}
}

func TestRunAddSourceNonInteractiveRequiresMissingFlags(t *testing.T) {
	resetSourceFlags()
	defer resetSourceFlags()
	t.Setenv("HOME", t.TempDir())

	err := runAddSourceWithPrompter(&fakeSourcePrompter{}, false)
	if err == nil {
		t.Fatal("expected an error for missing flags in non-interactive mode")
	}
	if !strings.Contains(err.Error(), "missing required flags: --type") {
		t.Fatalf("expected missing type error, got %v", err)
	}
}

func TestRunAddSourceRejectsDuplicateNameBeforeSave(t *testing.T) {
	resetSourceFlags()
	defer resetSourceFlags()
	t.Setenv("HOME", t.TempDir())

	if err := kavlaconfig.SaveConfig(&kavlaconfig.Config{Sources: map[string]kavlaconfig.SourceConfig{
		"analytics": {Type: "bigquery", Connection: "old-project"},
	}}); err != nil {
		t.Fatalf("SaveConfig returned error: %v", err)
	}

	sourceType = "bigquery"
	sourceName = "analytics"
	sourceConnection = "new-project"

	err := runAddSourceWithPrompter(&fakeSourcePrompter{}, false)
	if err == nil {
		t.Fatal("expected duplicate source name error")
	}
	if !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("expected duplicate name error, got %v", err)
	}
}

func TestRunAddSourceRetriesInvalidPromptedConnection(t *testing.T) {
	resetSourceFlags()
	defer resetSourceFlags()
	t.Setenv("HOME", t.TempDir())

	duckdbPath := filepath.Join(t.TempDir(), "analytics.duckdb")
	if err := os.WriteFile(duckdbPath, []byte("duckdb"), 0o600); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	prompter := &fakeSourcePrompter{
		selectAnswers: []string{"duckdb"},
		inputAnswers: []string{
			"analytics",
			filepath.Join(t.TempDir(), "missing.duckdb"),
			duckdbPath,
		},
	}

	if err := runAddSourceWithPrompter(prompter, true); err != nil {
		t.Fatalf("runAddSourceWithPrompter returned error: %v", err)
	}

	config := loadSavedConfig(t)
	if got := config.Sources["analytics"].Connection; got != duckdbPath {
		t.Fatalf("expected resolved duckdb path %q, got %q", duckdbPath, got)
	}
}

func TestValidateSourceNameRejectsInvalidIdentifiers(t *testing.T) {
	existing := map[string]kavlaconfig.SourceConfig{}
	cases := []string{"analytics.data", "analytics data", "1analytics", "analytics-raw", ""}
	for _, name := range cases {
		if err := validateSourceName(name, existing); err == nil {
			t.Fatalf("expected %q to be rejected", name)
		}
	}

	if err := validateSourceName("analytics_2026", existing); err != nil {
		t.Fatalf("expected valid source name, got %v", err)
	}
}
