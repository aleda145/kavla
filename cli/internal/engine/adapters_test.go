package engine

import (
	"strings"
	"testing"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
)

func newTestEngine(t *testing.T) *Engine {
	t.Helper()

	eng, err := New(map[string]kavlaconfig.SourceConfig{}, nil)
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}

	t.Cleanup(func() {
		_ = eng.Close()
	})

	return eng
}

func TestPreparePreviewSQLUsesFederatedWrappingWithoutExecutionEngine(t *testing.T) {
	eng := newTestEngine(t)

	wrappedSQL, err := eng.PreparePreviewSQL("", "", "SELECT 1", 25)
	if err != nil {
		t.Fatalf("PreparePreviewSQL returned error: %v", err)
	}

	expected := "SELECT * FROM (SELECT 1) LIMIT 25"
	if wrappedSQL != expected {
		t.Fatalf("expected %q, got %q", expected, wrappedSQL)
	}
}

func TestPreparePreviewSQLUsesAdapterWrappingWithExecutionEngineAndSourceName(t *testing.T) {
	eng := newTestEngine(t)

	wrappedSQL, err := eng.PreparePreviewSQL("bigquery", "analytics", "SELECT * FROM analytics.events", 25)
	if err != nil {
		t.Fatalf("PreparePreviewSQL returned error: %v", err)
	}

	if !strings.Contains(wrappedSQL, "bigquery_query('analytics'") {
		t.Fatalf("expected BigQuery adapter wrapper, got %q", wrappedSQL)
	}
}

func TestPreparePreviewSQLUsesPostgresAdapterWrappingWithExecutionEngineAndSourceName(t *testing.T) {
	eng := newTestEngine(t)

	wrappedSQL, err := eng.PreparePreviewSQL("postgres", "analytics", `SELECT * FROM "public"."events"`, 25)
	if err != nil {
		t.Fatalf("PreparePreviewSQL returned error: %v", err)
	}

	if !strings.Contains(wrappedSQL, "postgres_query('analytics'") {
		t.Fatalf("expected Postgres adapter wrapper, got %q", wrappedSQL)
	}
}

func TestPreparePreviewSQLRequiresSourceNameForSourceNativePreview(t *testing.T) {
	eng := newTestEngine(t)

	_, err := eng.PreparePreviewSQL("bigquery", "", "SELECT 1", 25)
	if err == nil {
		t.Fatal("expected an error when executionEngine is set without sourceName")
	}

	if !strings.Contains(err.Error(), "source-native preview mode requires sourceName") {
		t.Fatalf("expected source-native validation error, got %v", err)
	}
}
