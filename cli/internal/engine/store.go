package engine

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/aleda145/kavla/cli/internal/sources"
)

var storeIdentifier = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)

func (e *Engine) GetSourceSchemas(ctx context.Context, sourceName string) ([]string, error) {
	if err := e.ensureSourceAvailable(sourceName); err != nil {
		return nil, err
	}
	if e.sourceStatuses[sourceName].Type == "directory" {
		return []string{}, nil
	}
	rows, err := e.db.QueryContext(ctx, `
		SELECT schema_name FROM duckdb_schemas()
		WHERE database_name = ? AND (internal = false OR schema_name = 'main')
		ORDER BY schema_name
	`, sourceName)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	schemas := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		schemas = append(schemas, name)
	}
	return schemas, rows.Err()
}

type StoredTable struct {
	SourceName string              `json:"sourceName"`
	SourceType string              `json:"sourceType"`
	TableName  string              `json:"tableName"`
	TableRef   string              `json:"tableRef"`
	RowCount   int64               `json:"rowCount"`
	Schema     []map[string]string `json:"schema"`
	Warning    string              `json:"warning,omitempty"`
}

func (e *Engine) StoreDestination(sourceName, schemaName, tableName string) (*StoredTable, error) {
	if err := e.ensureSourceAvailable(sourceName); err != nil {
		return nil, err
	}
	if !storeIdentifier.MatchString(tableName) {
		return nil, fmt.Errorf("table name must start with a letter or underscore and contain only letters, numbers, and underscores")
	}
	sourceType := e.sourceStatuses[sourceName].Type
	if sourceType == "postgres" && len(tableName) > 63 {
		return nil, fmt.Errorf("Postgres table names must be at most 63 characters")
	}
	if sourceName == UploadedFilesSource || sourceType == "duckdb" {
		if schemaName == "" {
			schemaName = "main"
		}
	} else if sourceType == "postgres" && schemaName == "" {
		schemaName = "public"
	}
	if sourceType == "directory" {
		if schemaName != "" {
			return nil, fmt.Errorf("directory destinations do not use a schema")
		}
	} else if !storeIdentifier.MatchString(schemaName) {
		return nil, fmt.Errorf("a valid schema or BigQuery dataset name is required")
	}
	if sourceName == UploadedFilesSource && schemaName != "main" {
		return nil, fmt.Errorf("uploaded_files uses the main schema")
	}
	if sourceName != UploadedFilesSource && sourceType != "directory" {
		if _, ok := e.adapters[sourceName].(sources.WritableCatalog); !ok {
			return nil, fmt.Errorf("source %q does not support Store", sourceName)
		}
	}
	parts := []string{sourceName, schemaName, tableName}
	if sourceType == "directory" {
		parts = []string{sourceName, tableName}
	}
	return &StoredTable{SourceName: sourceName, SourceType: sourceType, TableName: tableName, TableRef: strings.Join(parts, ".")}, nil
}

// SnapshotQuery evaluates once, without a preview limit. The snapshot survives
// detaching the destination, even when the query reads from that same catalog.
func (e *Engine) SnapshotQuery(ctx context.Context, query, outputPath string, result *StoredTable) error {
	if err := e.ensureDeferredTables(ctx, query); err != nil {
		return err
	}
	if _, err := e.db.ExecContext(ctx, fmt.Sprintf("COPY (%s) TO %s (FORMAT PARQUET, COMPRESSION SNAPPY)", query, sqlStringLiteral(outputPath))); err != nil {
		return fmt.Errorf("snapshot query: %w", err)
	}
	relation := "read_parquet(" + sqlStringLiteral(outputPath) + ")"
	if err := e.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+relation).Scan(&result.RowCount); err != nil {
		return err
	}
	rows, err := e.db.QueryContext(ctx, "SELECT * FROM "+relation+" LIMIT 0")
	if err != nil {
		return err
	}
	defer rows.Close()
	columns, err := rows.ColumnTypes()
	if err != nil {
		return err
	}
	result.Schema = make([]map[string]string, len(columns))
	for i, column := range columns {
		result.Schema[i] = map[string]string{"name": column.Name(), "type": column.DatabaseTypeName()}
	}
	return rows.Err()
}

// StoreSnapshot requires the caller to exclude concurrent operations on this
// session while the selected catalog is briefly writable.
func (e *Engine) StoreSnapshot(ctx context.Context, snapshotPath string, result *StoredTable) (err error) {
	adapter := e.adapters[result.SourceName]
	if writer, ok := adapter.(sources.DirectoryWriter); ok {
		return writer.StoreParquet(ctx, snapshotPath, result.TableName, e.db)
	}
	writer, ok := adapter.(sources.WritableCatalog)
	if !ok {
		return fmt.Errorf("source %q does not support Store", result.SourceName)
	}
	detachSQL := "DETACH " + quoteIdentifier(result.SourceName)
	if _, err := e.db.ExecContext(ctx, detachSQL); err != nil {
		return fmt.Errorf("release read-only source: %w", err)
	}
	writable := false
	stored := false
	defer func() {
		// Cancellation must never leave the source writable.
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		var restoreErr error
		if writable {
			_, restoreErr = e.db.ExecContext(cleanupCtx, detachSQL)
			if restoreErr == nil {
				writable = false
			}
		}
		if restoreErr == nil {
			_, restoreErr = e.db.ExecContext(cleanupCtx, writer.AttachSQL(result.SourceName, true))
		}
		if restoreErr != nil {
			// Fail closed if detaching failed: no subsequent queries may use a
			// connection that could still have write access.
			if writable {
				_ = e.db.Close()
			}
			message := fmt.Sprintf("could not restore read-only source; reconnect the canvas: %v", restoreErr)
			if stored {
				result.Warning = "Table was stored, but " + message
			} else {
				err = errors.Join(err, fmt.Errorf("%s", message))
			}
		}
	}()
	if _, err := e.db.ExecContext(ctx, writer.AttachSQL(result.SourceName, false)); err != nil {
		return fmt.Errorf("open source for Store (write permissions and exclusive DuckDB file access are required): %w", err)
	}
	writable = true
	parts := strings.Split(result.TableRef, ".")
	for i, part := range parts {
		parts[i] = quoteIdentifier(part)
	}
	// CREATE, never CREATE OR REPLACE: a collision must not destroy existing data.
	statement := "CREATE TABLE " + strings.Join(parts, ".") + " AS SELECT * FROM read_parquet(" + sqlStringLiteral(snapshotPath) + ")"
	if _, err := e.db.ExecContext(ctx, statement); err != nil {
		return fmt.Errorf("store table: %w", err)
	}
	stored = true
	return nil
}
