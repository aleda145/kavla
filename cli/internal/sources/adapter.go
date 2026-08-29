package sources

import (
	"context"
	"database/sql"
	"fmt"
	"slices"
	"strings"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
	_ "github.com/duckdb/duckdb-go/v2"
)

type RegistrationContext struct {
	DB      *sql.DB
	Logf    func(string, ...interface{})
	ExecSQL func(label, sql string) error
}

type StartupRequirements struct {
	AllowedDirectories []string
	AllowedPaths       []string
	StartupSQL         []string
}

type DeferredTableMaterializer interface {
	MaterializeReferencedTables(ctx context.Context, query string, exec func(string) error) error
}

type Adapter interface {
	Type() string
	StartupRequirements(src kavlaconfig.SourceConfig) (*StartupRequirements, error)
	Validate(ctx context.Context, name string, src kavlaconfig.SourceConfig) error
	Init(ctx context.Context, reg RegistrationContext, name string, src kavlaconfig.SourceConfig) error
	ListTables(ctx context.Context) ([]string, error)
	PreparePreviewSQL(sourceName, sql string, limit int) (string, error)
	DescribeTableSQL(tableRef string) (string, bool, error)
	SourceStatsSQL(tableRef string) (string, bool, error)
	ExportTableSQL(tableRef string) (string, bool, error)
}

type AdapterFactory func() Adapter

func BuiltIn() map[string]AdapterFactory {
	adapters := make(map[string]AdapterFactory, len(BuiltInDefinitions()))
	for _, definition := range BuiltInDefinitions() {
		adapters[definition.Type] = definition.NewAdapter
	}
	return adapters
}

func DefaultPreviewSQL(sourceName, sql string, limit int) (string, error) {
	if limit <= 0 {
		return fmt.Sprintf("SELECT * FROM (%s)", sql), nil
	}
	return fmt.Sprintf("SELECT * FROM (%s) LIMIT %d", sql, limit), nil
}

func splitQualifiedTableRef(tableRef string) ([]string, bool) {
	rawParts := strings.Split(tableRef, ".")
	parts := make([]string, 0, len(rawParts))
	for _, rawPart := range rawParts {
		part := strings.TrimSpace(rawPart)
		if len(part) >= 2 && part[0] == '"' && part[len(part)-1] == '"' {
			part = strings.ReplaceAll(part[1:len(part)-1], `""`, `"`)
		}
		if part == "" {
			return nil, false
		}
		parts = append(parts, part)
	}

	if len(parts) < 2 {
		return nil, false
	}

	return parts, true
}

func sourceTablePath(sourceName, tableRef string) ([]string, bool) {
	parts, ok := splitQualifiedTableRef(tableRef)
	if !ok || parts[0] != sourceName {
		return nil, false
	}
	return parts[1:], true
}

const isolatedCatalogName = "source"

func sqlSingleQuoted(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func openIsolatedDuckDB() (*sql.DB, error) {
	db, err := sql.Open("duckdb", ":memory:")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

func withIsolatedCatalog(ctx context.Context, startupSQL []string, attachSQL string, fn func(*sql.DB) error) error {
	db, err := openIsolatedDuckDB()
	if err != nil {
		return err
	}
	defer db.Close()

	for _, sql := range startupSQL {
		if _, err := db.ExecContext(ctx, sql); err != nil {
			return err
		}
	}
	if _, err := db.ExecContext(ctx, attachSQL); err != nil {
		return err
	}
	return fn(db)
}

func listCatalogSchemas(ctx context.Context, db *sql.DB, catalogName string) ([]string, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT schema_name
		FROM duckdb_schemas()
		WHERE database_name = ?
		  AND (internal = false OR schema_name = 'main')
		ORDER BY CASE WHEN schema_name = 'main' THEN 0 ELSE 1 END, schema_name
	`, catalogName)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var schemas []string
	for rows.Next() {
		var schemaName string
		if err := rows.Scan(&schemaName); err != nil {
			return nil, err
		}
		schemas = append(schemas, schemaName)
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}

	return schemas, nil
}

func listTablesInScope(ctx context.Context, db *sql.DB, scope string) ([]string, error) {
	rows, err := db.QueryContext(ctx, fmt.Sprintf("SHOW TABLES FROM %s", scope))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tables []string
	for rows.Next() {
		var tableName string
		if err := rows.Scan(&tableName); err != nil {
			return nil, err
		}
		tables = append(tables, tableName)
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}

	return tables, nil
}

func formatSourceTableRef(sourceName, schemaName, tableName string) string {
	if schemaName != "" && schemaName != "main" {
		return sourceName + "." + schemaName + "." + tableName
	}
	return sourceName + "." + tableName
}

func listCatalogObjects(ctx context.Context, db *sql.DB, catalogName, sourceName string) ([]string, error) {
	schemas, err := listCatalogSchemas(ctx, db, catalogName)
	if err != nil {
		return nil, err
	}

	tableSet := make(map[string]struct{})
	tables := make([]string, 0)
	for _, schemaName := range schemas {
		scope := doubleQuotedQualified([]string{catalogName, schemaName})
		names, err := listTablesInScope(ctx, db, scope)
		if err != nil {
			return nil, err
		}
		for _, tableName := range names {
			tableRef := formatSourceTableRef(sourceName, schemaName, tableName)
			if _, exists := tableSet[tableRef]; exists {
				continue
			}
			tableSet[tableRef] = struct{}{}
			tables = append(tables, tableRef)
		}
	}

	slices.Sort(tables)
	return tables, nil
}

func listCatalogObjectsIsolated(ctx context.Context, startupSQL []string, attachSQL, sourceName string) ([]string, error) {
	var tables []string
	err := withIsolatedCatalog(ctx, startupSQL, attachSQL, func(db *sql.DB) error {
		var err error
		tables, err = listCatalogObjects(ctx, db, isolatedCatalogName, sourceName)
		return err
	})
	if err != nil {
		return nil, err
	}
	return tables, nil
}
