package engine

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
	"github.com/aleda145/kavla/cli/internal/sources"
	_ "github.com/duckdb/duckdb-go/v2"
)

type stubAdapter struct {
	typeName     string
	requirements *sources.StartupRequirements
	requireErr   error
	validateErr  error
	initErr      error
	tables       []string
}

func (a *stubAdapter) Type() string {
	return a.typeName
}

func (a *stubAdapter) StartupRequirements(src kavlaconfig.SourceConfig) (*sources.StartupRequirements, error) {
	if a.requireErr != nil {
		return nil, a.requireErr
	}
	if a.requirements != nil {
		return a.requirements, nil
	}
	return &sources.StartupRequirements{}, nil
}

func (a *stubAdapter) Validate(ctx context.Context, name string, src kavlaconfig.SourceConfig) error {
	return a.validateErr
}

func (a *stubAdapter) Init(ctx context.Context, reg sources.RegistrationContext, name string, src kavlaconfig.SourceConfig) error {
	return a.initErr
}

func (a *stubAdapter) ListTables(ctx context.Context) ([]string, error) {
	return append([]string(nil), a.tables...), nil
}

func (a *stubAdapter) PreparePreviewSQL(sourceName, sql string, limit int) (string, error) {
	return sources.DefaultPreviewSQL(sourceName, sql, limit)
}

func (a *stubAdapter) DescribeTableSQL(tableRef string) (string, bool, error) {
	return "", false, nil
}

func (a *stubAdapter) SourceStatsSQL(tableRef string) (string, bool, error) {
	return "", false, nil
}

func (a *stubAdapter) ExportTableSQL(tableRef string) (string, bool, error) {
	return "", false, nil
}

func newStubEngine(t *testing.T, registry map[string]sources.AdapterFactory) *Engine {
	t.Helper()
	db, err := sql.Open("duckdb", ":memory:")
	if err != nil {
		t.Fatalf("sql.Open returned error: %v", err)
	}
	eng := &Engine{
		db:              db,
		logf:            func(string, ...interface{}) {},
		adapterRegistry: registry,
		adapters:        make(map[string]sources.Adapter),
		sourceStatuses:  make(map[string]SourceStatus),
	}
	t.Cleanup(func() {
		_ = eng.Close()
	})
	return eng
}

func TestInitializeStartupKeepsHealthySourcesWhenOneSourceFailsValidation(t *testing.T) {
	eng := newStubEngine(t, map[string]sources.AdapterFactory{
		"healthy": func() sources.Adapter {
			return &stubAdapter{typeName: "healthy", tables: []string{"good.items"}}
		},
		"broken": func() sources.Adapter {
			return &stubAdapter{typeName: "broken", validateErr: errors.New("validate failed")}
		},
	})

	err := eng.initializeStartup(context.Background(), map[string]kavlaconfig.SourceConfig{
		"good": {Type: "healthy"},
		"bad":  {Type: "broken"},
	}, nil)
	if err != nil {
		t.Fatalf("initializeStartup returned error: %v", err)
	}

	tables, err := eng.GetTables("good")
	if err != nil {
		t.Fatalf("GetTables for healthy source returned error: %v", err)
	}
	if len(tables) != 1 || tables[0] != "good.items" {
		t.Fatalf("unexpected healthy tables: %v", tables)
	}

	_, err = eng.GetTables("bad")
	if err == nil {
		t.Fatal("expected unavailable source error")
	}
	if !strings.Contains(err.Error(), "validate failed") {
		t.Fatalf("expected validation error, got %v", err)
	}

	statuses := eng.SourceStatuses()
	if len(statuses) != 2 {
		t.Fatalf("expected 2 source statuses, got %d", len(statuses))
	}

	statusByName := make(map[string]SourceStatus, len(statuses))
	for _, status := range statuses {
		statusByName[status.Name] = status
	}
	if !statusByName["good"].Available {
		t.Fatalf("expected good source to be available: %+v", statusByName["good"])
	}
	if statusByName["bad"].Available {
		t.Fatalf("expected bad source to be unavailable: %+v", statusByName["bad"])
	}
	if !strings.Contains(statusByName["bad"].Error, "validate failed") {
		t.Fatalf("expected bad source error to mention validation failure, got %+v", statusByName["bad"])
	}
}
