package sources

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"testing"

	_ "github.com/duckdb/duckdb-go/v2"
)

func createDuckDBFile(t *testing.T, path string, statements ...string) {
	t.Helper()
	db, err := sql.Open("duckdb", path)
	if err != nil {
		t.Fatalf("sql.Open returned error: %v", err)
	}
	defer db.Close()

	for _, stmt := range statements {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("Exec %q returned error: %v", stmt, err)
		}
	}
}

func TestDuckDBAdapterListTablesUsesIsolatedConnection(t *testing.T) {
	duckPath := filepath.Join(t.TempDir(), "primary.duckdb")
	otherPath := filepath.Join(t.TempDir(), "other.duckdb")

	createDuckDBFile(t, duckPath,
		"CREATE TABLE sample(id INTEGER)",
		"CREATE SCHEMA extras",
		"CREATE TABLE extras.events(id INTEGER)",
		"CREATE VIEW extras.event_view AS SELECT * FROM extras.events",
	)
	createDuckDBFile(t, otherPath, "CREATE TABLE unrelated(id INTEGER)")

	adapter := &duckDBAdapter{
		sourceName: "duck_src",
		connection: duckPath,
	}
	tables, err := adapter.ListTables(context.Background())
	if err != nil {
		t.Fatalf("ListTables returned error: %v", err)
	}

	got := make(map[string]struct{}, len(tables))
	for _, table := range tables {
		got[table] = struct{}{}
	}
	if _, ok := got["duck_src.sample"]; !ok {
		t.Fatalf("expected duck_src.sample in %v", tables)
	}
	if _, ok := got["duck_src.extras.events"]; !ok {
		t.Fatalf("expected duck_src.extras.events in %v", tables)
	}
	if _, ok := got["duck_src.extras.event_view"]; !ok {
		t.Fatalf("expected duck_src.extras.event_view in %v", tables)
	}
	if _, ok := got["other_src.unrelated"]; ok {
		t.Fatalf("did not expect other_src.unrelated in %v", tables)
	}
}

func TestDirectoryAdapterListTablesUsesStoredInventory(t *testing.T) {
	adapter := &directoryAdapter{
		sourceName: "dir_src",
		tableRefs:  []string{"dir_src.orders", "dir_src.pending"},
		pendingTables: map[string]deferredTable{
			"dir_src.pending": {ref: "dir_src.pending"},
		},
	}

	tables, err := adapter.ListTables(context.Background())
	if err != nil {
		t.Fatalf("ListTables returned error: %v", err)
	}

	got := make(map[string]struct{}, len(tables))
	for _, table := range tables {
		got[table] = struct{}{}
	}
	if _, ok := got["dir_src.orders"]; !ok {
		t.Fatalf("expected dir_src.orders in %v", tables)
	}
	if _, ok := got["dir_src.pending"]; !ok {
		t.Fatalf("expected dir_src.pending in %v", tables)
	}
	if _, ok := got["other_src.ignore_me"]; ok {
		t.Fatalf("did not expect other_src.ignore_me in %v", tables)
	}
}

func TestDirectoryAdapterRetriesFailedLazyViewInitialization(t *testing.T) {
	adapter := &directoryAdapter{
		pendingTables: map[string]deferredTable{
			"dir_src.orders": {
				ref:       "dir_src.orders",
				matchName: "orders",
				createSQL: "CREATE VIEW orders",
			},
		},
	}
	wantError := errors.New("view creation failed")

	err := adapter.MaterializeReferencedTables(context.Background(), "SELECT * FROM dir_src.orders", func(string) error {
		return wantError
	})
	if !errors.Is(err, wantError) {
		t.Fatalf("MaterializeReferencedTables error = %v, expected %v", err, wantError)
	}
	if _, ok := adapter.pendingTables["dir_src.orders"]; !ok {
		t.Fatal("failed view initialization must remain pending for a retry")
	}

	callCount := 0
	err = adapter.MaterializeReferencedTables(context.Background(), "SELECT * FROM dir_src.orders", func(sql string) error {
		callCount++
		if sql != "CREATE VIEW orders" {
			t.Fatalf("initialization SQL = %q", sql)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("MaterializeReferencedTables retry returned error: %v", err)
	}
	if callCount != 1 {
		t.Fatalf("view initialization ran %d times, expected once", callCount)
	}
	if _, ok := adapter.pendingTables["dir_src.orders"]; ok {
		t.Fatal("successful view initialization must no longer be pending")
	}
}

func TestDirectoryTableNameRemovesSQLQualificationCharacters(t *testing.T) {
	tests := map[string]string{
		"orders":                           "orders",
		"nested/orders.v2":                 "nested_orders_v2",
		".hidden/data export":              "hidden_data_export",
		"nested/path.with-many separators": "nested_path_with_many_separators",
	}

	for input, expected := range tests {
		if actual := directoryTableName(input); actual != expected {
			t.Fatalf("directoryTableName(%q) = %q, expected %q", input, actual, expected)
		}
	}
}

func TestCreateDuckDBFileCreatesReadableDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sanity.duckdb")
	createDuckDBFile(t, path, "CREATE TABLE sample(id INTEGER)")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected database file to exist: %v", err)
	}
}
