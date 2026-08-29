package engine

import (
	"strings"
	"testing"
)

func TestBuildRemoteFileMountSQLUsesParquetReader(t *testing.T) {
	sql, err := buildRemoteFileMountSQL("orders", "orders.parquet", "https://example.com/orders.parquet?sig=1")
	if err != nil {
		t.Fatalf("buildRemoteFileMountSQL returned error: %v", err)
	}

	if !strings.Contains(sql, `CREATE OR REPLACE VIEW "orders"`) {
		t.Fatalf("expected quoted view name, got %q", sql)
	}
	if !strings.Contains(sql, "read_parquet('https://example.com/orders.parquet?sig=1')") {
		t.Fatalf("expected parquet reader, got %q", sql)
	}
}

func TestBuildRemoteFileMountSQLUsesCSVReader(t *testing.T) {
	sql, err := buildRemoteFileMountSQL("orders", "ORDERS.CSV", "https://example.com/orders.csv")
	if err != nil {
		t.Fatalf("buildRemoteFileMountSQL returned error: %v", err)
	}

	if !strings.Contains(sql, "read_csv_auto('https://example.com/orders.csv')") {
		t.Fatalf("expected csv reader, got %q", sql)
	}
}

func TestBuildRemoteFileMountSQLUsesJSONReader(t *testing.T) {
	sql, err := buildRemoteFileMountSQL("events", "events.ndjson", "https://example.com/events.ndjson")
	if err != nil {
		t.Fatalf("buildRemoteFileMountSQL returned error: %v", err)
	}

	if !strings.Contains(sql, "read_json_auto('https://example.com/events.ndjson')") {
		t.Fatalf("expected json reader, got %q", sql)
	}
}

func TestBuildRemoteFileMountSQLRejectsUnsupportedFileTypes(t *testing.T) {
	_, err := buildRemoteFileMountSQL("events", "events.tsv", "https://example.com/events.tsv")
	if err == nil {
		t.Fatal("expected unsupported mounted file type error")
	}

	if !strings.Contains(err.Error(), "unsupported mounted file type") {
		t.Fatalf("expected unsupported type error, got %v", err)
	}
}
