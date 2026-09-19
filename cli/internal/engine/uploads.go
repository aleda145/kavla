package engine

import (
	"context"
	"fmt"
	"strings"

	"github.com/apache/arrow/go/v14/arrow/array"
)

const UploadedFilesSource = "uploaded_files"

func (e *Engine) EnableUploadedFiles() { e.sourceStatuses[UploadedFilesSource] = SourceStatus{Name: UploadedFilesSource, Type: "duckdb", Available: true} }

func (e *Engine) ImportUploadedFile(ctx context.Context, tableName, fileName, path string) error {
	reader, err := readerForMountedFile(fileName)
	if err != nil { return err }
	_, err = e.db.ExecContext(ctx, fmt.Sprintf("CREATE TABLE uploaded_files.main.%s AS SELECT * FROM %s(%s)", quoteIdentifier(tableName), reader, sqlStringLiteral(path)))
	return err
}

func (e *Engine) DropUploadedFile(ctx context.Context, tableName string) error {
	_, err := e.db.ExecContext(ctx, "DROP TABLE IF EXISTS uploaded_files.main."+quoteIdentifier(tableName))
	return err
}

func (e *Engine) uploadedTables(ctx context.Context) ([]string, error) {
	rows, err := e.db.QueryContext(ctx, "SELECT table_name FROM information_schema.tables WHERE table_catalog = 'uploaded_files' AND table_schema = 'main' ORDER BY table_name")
	if err != nil { return nil, err }
	defer rows.Close()
	tables := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil { return nil, err }
		tables = append(tables, "uploaded_files.main."+name)
	}
	return tables, rows.Err()
}

func (e *Engine) ValidateQuery(ctx context.Context, query string) error {
	if err := e.ensureDeferredTables(ctx, query); err != nil { return err }
	statement, err := e.db.PrepareContext(ctx, query)
	if err != nil { return err }
	return statement.Close()
}

// Widget queries see exactly the rows passed to the widget, on one connection.
// Temporary tables never replace a document's sources or another widget's data.
type WidgetColumn struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

func (e *Engine) QueryWidget(ctx context.Context, query, name string, columns []WidgetColumn, values [][]interface{}) (array.RecordReader, error) {
	if name == "" || len(columns) == 0 { return nil, fmt.Errorf("widget table name and columns are required") }
	conn, err := e.db.Conn(ctx)
	if err != nil { return nil, err }
	defer conn.Close()
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil { return nil, err }
	defer tx.Rollback()
	definitions := make([]string, len(columns))
	placeholders := make([]string, len(columns))
	for i, column := range columns {
		switch column.Type {
		case "DOUBLE", "BOOLEAN", "VARCHAR":
		default: return nil, fmt.Errorf("unsupported widget column type %q", column.Type)
		}
		definitions[i] = quoteIdentifier(column.Name)+" "+column.Type
		placeholders[i] = "?"
	}
	if _, err := tx.ExecContext(ctx, "CREATE TEMP TABLE "+quoteIdentifier(name)+" ("+strings.Join(definitions, ",")+")"); err != nil { return nil, err }
	statement, err := tx.PrepareContext(ctx, "INSERT INTO "+quoteIdentifier(name)+" VALUES ("+strings.Join(placeholders, ",")+")")
	if err != nil { return nil, err }
	defer statement.Close()
	for _, row := range values {
		if len(row) != len(columns) { return nil, fmt.Errorf("widget row does not match its columns") }
		if _, err := statement.ExecContext(ctx, row...); err != nil { return nil, err }
	}
	rows, err := tx.QueryContext(ctx, "SELECT * FROM ("+strings.TrimRight(strings.TrimSpace(query), ";")+")")
	if err != nil { return nil, err }
	defer rows.Close()
	return rowsToArrow(ctx, rows)
}

