package sources

import (
	"os"
	"path/filepath"
	"testing"
)

func definitionForType(t *testing.T, sourceType string) Definition {
	t.Helper()
	for _, definition := range BuiltInDefinitions() {
		if definition.Type == sourceType {
			return definition
		}
	}
	t.Fatalf("definition for type %q not found", sourceType)
	return Definition{}
}

func TestDuckDBDefinitionResolvesExistingFilePath(t *testing.T) {
	definition := definitionForType(t, "duckdb")
	path := filepath.Join(t.TempDir(), "analytics.duckdb")
	if err := os.WriteFile(path, []byte("duckdb"), 0o600); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	resolved, err := definition.ResolveConnection(path)
	if err != nil {
		t.Fatalf("ResolveConnection returned error: %v", err)
	}
	if resolved != path {
		t.Fatalf("expected resolved path %q, got %q", path, resolved)
	}
}

func TestDirectoryDefinitionExpandsHomePath(t *testing.T) {
	definition := definitionForType(t, "directory")
	home := t.TempDir()
	t.Setenv("HOME", home)
	path := filepath.Join(home, "datasets")
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}

	resolved, err := definition.ResolveConnection("~/datasets")
	if err != nil {
		t.Fatalf("ResolveConnection returned error: %v", err)
	}
	if resolved != path {
		t.Fatalf("expected resolved path %q, got %q", path, resolved)
	}
}

func TestDuckDBDefinitionRejectsMissingFile(t *testing.T) {
	definition := definitionForType(t, "duckdb")
	_, err := definition.ResolveConnection(filepath.Join(t.TempDir(), "missing.duckdb"))
	if err == nil {
		t.Fatal("expected missing file error")
	}
}

func TestBigQueryDefinitionNormalizesProjectPrefix(t *testing.T) {
	definition := definitionForType(t, "bigquery")
	resolved, err := definition.ResolveConnection("project=my-project")
	if err != nil {
		t.Fatalf("ResolveConnection returned error: %v", err)
	}
	if resolved != "my-project" {
		t.Fatalf("expected my-project, got %q", resolved)
	}
}

func TestBigQueryDefinitionRejectsWhitespace(t *testing.T) {
	definition := definitionForType(t, "bigquery")
	_, err := definition.ResolveConnection("my project")
	if err == nil {
		t.Fatal("expected whitespace validation error")
	}
}

func TestPostgresDefinitionTrimsConnectionString(t *testing.T) {
	definition := definitionForType(t, "postgres")
	resolved, err := definition.ResolveConnection("  postgres://user:password@localhost:5432/analytics  ")
	if err != nil {
		t.Fatalf("ResolveConnection returned error: %v", err)
	}
	if resolved != "postgres://user:password@localhost:5432/analytics" {
		t.Fatalf("unexpected resolved connection %q", resolved)
	}
}

func TestPostgresDefinitionRejectsEmptyConnectionString(t *testing.T) {
	definition := definitionForType(t, "postgres")
	_, err := definition.ResolveConnection("   ")
	if err == nil {
		t.Fatal("expected empty connection validation error")
	}
}
