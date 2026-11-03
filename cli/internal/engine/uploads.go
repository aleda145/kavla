package engine

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/apache/arrow/go/v14/arrow/array"
)

const UploadedFilesSource = "uploaded_files"

type uploadedFile struct {
	name  string
	path  string
	ready bool
}

func (e *Engine) RegisterUploadedFile(tableName, fileName, path string) error {
	if e.uploads == nil {
		e.uploads = make(map[string]uploadedFile)
	}
	e.uploads[tableName] = uploadedFile{name: fileName, path: path}
	return nil
}

func (e *Engine) ensureUploadedFiles(ctx context.Context, sql string) error {
	qualifiedSQL := strings.ReplaceAll(sql, `"`, "")
	for name, file := range e.uploads {
		if file.ready {
			continue
		}
		// Names are document identifiers. Match complete identifiers (including
		// quoted forms) so a query for one upload does not open unrelated files.
		pattern := `(?i)\buploaded_files\s*\.\s*(?:main\s*\.\s*)?` + regexp.QuoteMeta(name) + `\b`
		if !regexp.MustCompile(pattern).MatchString(qualifiedSQL) {
			continue
		}
		if err := e.ImportUploadedFile(ctx, name, file.name, file.path); err != nil {
			return fmt.Errorf("open uploaded source %q: %w", name, err)
		}
	}
	return nil
}

func (e *Engine) EnableUploadedFiles() {
	e.sourceStatuses[UploadedFilesSource] = SourceStatus{Name: UploadedFilesSource, Type: "duckdb", Available: true}
}

// ImportUploadedFile registers the original file without copying its rows into
// DuckDB. The document owns the file and keeps it available until the view drops.
func (e *Engine) ImportUploadedFile(ctx context.Context, tableName, fileName, path string) error {
	reader, err := readerForMountedFile(fileName)
	if err != nil {
		return err
	}
	_, err = e.db.ExecContext(ctx, fmt.Sprintf("CREATE OR REPLACE VIEW uploaded_files.main.%s AS SELECT * FROM %s(%s)", quoteIdentifier(tableName), reader, sqlStringLiteral(path)))
	if err == nil {
		if e.uploads == nil {
			e.uploads = make(map[string]uploadedFile)
		}
		e.uploads[tableName] = uploadedFile{name: fileName, path: path, ready: true}
	}
	return err
}

func (e *Engine) DropUploadedFile(ctx context.Context, tableName string) error {
	_, err := e.db.ExecContext(ctx, "DROP VIEW IF EXISTS uploaded_files.main."+quoteIdentifier(tableName))
	if err == nil {
		delete(e.uploads, tableName)
	}
	return err
}

func (e *Engine) uploadedTables(ctx context.Context) ([]string, error) {
	rows, err := e.db.QueryContext(ctx, "SELECT table_name FROM information_schema.tables WHERE table_catalog = 'uploaded_files' AND table_schema = 'main' ORDER BY table_name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tables := []string{}
	seen := make(map[string]bool)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		tables = append(tables, "uploaded_files.main."+name)
		seen[name] = true
	}
	for name := range e.uploads {
		if !seen[name] {
			tables = append(tables, "uploaded_files.main."+name)
		}
	}
	sort.Strings(tables)
	return tables, rows.Err()
}

func (e *Engine) ValidateQuery(ctx context.Context, query string) error {
	if err := e.ensureDeferredTables(ctx, query); err != nil {
		return err
	}
	statement, err := e.db.PrepareContext(ctx, query)
	if err != nil {
		return err
	}
	return statement.Close()
}

// Widget queries see exactly the rows passed to the widget, on one connection.
// Temporary tables never replace a document's sources or another widget's data.
type WidgetColumn struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

func (e *Engine) QueryWidget(ctx context.Context, query, name string, columns []WidgetColumn, values [][]interface{}) (array.RecordReader, error) {
	if name == "" || len(columns) == 0 {
		return nil, fmt.Errorf("widget table name and columns are required")
	}
	conn, err := e.db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	definitions := make([]string, len(columns))
	placeholders := make([]string, len(columns))
	for i, column := range columns {
		switch column.Type {
		case "DOUBLE", "BOOLEAN", "VARCHAR":
		default:
			return nil, fmt.Errorf("unsupported widget column type %q", column.Type)
		}
		definitions[i] = quoteIdentifier(column.Name) + " " + column.Type
		placeholders[i] = "?"
	}
	if _, err := tx.ExecContext(ctx, "CREATE TEMP TABLE "+quoteIdentifier(name)+" ("+strings.Join(definitions, ",")+")"); err != nil {
		return nil, err
	}
	statement, err := tx.PrepareContext(ctx, "INSERT INTO "+quoteIdentifier(name)+" VALUES ("+strings.Join(placeholders, ",")+")")
	if err != nil {
		return nil, err
	}
	defer statement.Close()
	for _, row := range values {
		if len(row) != len(columns) {
			return nil, fmt.Errorf("widget row does not match its columns")
		}
		if _, err := statement.ExecContext(ctx, row...); err != nil {
			return nil, err
		}
	}
	rows, err := tx.QueryContext(ctx, "SELECT * FROM ("+strings.TrimRight(strings.TrimSpace(query), ";")+")")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return rowsToArrow(ctx, rows)
}
