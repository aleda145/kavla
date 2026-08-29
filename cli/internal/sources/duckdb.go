package sources

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
)

type duckDBAdapter struct {
	sourceName string
	connection string
}

func (duckDBAdapter) Type() string {
	return "duckdb"
}

func (duckDBAdapter) StartupRequirements(src kavlaconfig.SourceConfig) (*StartupRequirements, error) {
	absPath, err := filepath.Abs(src.Connection)
	if err != nil {
		return nil, fmt.Errorf("resolve duckdb source path: %w", err)
	}
	return &StartupRequirements{
		AllowedPaths: []string{filepath.Clean(absPath)},
	}, nil
}

func (d *duckDBAdapter) Validate(ctx context.Context, name string, src kavlaconfig.SourceConfig) error {
	d.sourceName = name
	d.connection = src.Connection
	_, err := d.ListTables(ctx)
	return err
}

func (d *duckDBAdapter) Init(ctx context.Context, reg RegistrationContext, name string, src kavlaconfig.SourceConfig) error {
	d.sourceName = name
	d.connection = src.Connection
	sql := fmt.Sprintf("ATTACH %s AS \"%s\" (READ_ONLY)", sqlSingleQuoted(src.Connection), name)
	if reg.ExecSQL != nil {
		if err := reg.ExecSQL(fmt.Sprintf("Attach DuckDB source '%s'", name), sql); err != nil {
			return err
		}
	} else if _, err := reg.DB.ExecContext(ctx, sql); err != nil {
		return fmt.Errorf("ATTACH duckdb: %w", err)
	}
	reg.Logf("Source '%s' (duckdb): attached in READ_ONLY mode\n", name)
	return nil
}

func (d *duckDBAdapter) ListTables(ctx context.Context) ([]string, error) {
	if strings.TrimSpace(d.connection) == "" {
		return nil, fmt.Errorf("duckdb source connection is required")
	}
	attachSQL := fmt.Sprintf("ATTACH %s AS \"%s\" (READ_ONLY)", sqlSingleQuoted(d.connection), isolatedCatalogName)
	return listCatalogObjectsIsolated(ctx, nil, attachSQL, d.sourceName)
}

func (duckDBAdapter) PreparePreviewSQL(sourceName, sql string, limit int) (string, error) {
	return DefaultPreviewSQL(sourceName, sql, limit)
}

func (d *duckDBAdapter) DescribeTableSQL(tableRef string) (string, bool, error) {
	tablePath, ok := sourceTablePath(d.sourceName, tableRef)
	if !ok {
		return "", false, nil
	}
	return fmt.Sprintf("DESCRIBE %s", doubleQuotedQualified(append([]string{d.sourceName}, tablePath...))), true, nil
}

func (d *duckDBAdapter) SourceStatsSQL(tableRef string) (string, bool, error) {
	tablePath, ok := sourceTablePath(d.sourceName, tableRef)
	if !ok {
		return "", false, nil
	}
	return fmt.Sprintf("SELECT COUNT(*) FROM %s", doubleQuotedQualified(append([]string{d.sourceName}, tablePath...))), true, nil
}

func (d *duckDBAdapter) ExportTableSQL(tableRef string) (string, bool, error) {
	tablePath, ok := sourceTablePath(d.sourceName, tableRef)
	if !ok {
		return "", false, nil
	}
	return fmt.Sprintf("SELECT * FROM %s", doubleQuotedQualified(append([]string{d.sourceName}, tablePath...))), true, nil
}

func doubleQuotedQualified(parts []string) string {
	quoted := make([]string, 0, len(parts))
	for _, part := range parts {
		quoted = append(quoted, `"`+strings.ReplaceAll(part, `"`, `""`)+`"`)
	}
	return strings.Join(quoted, ".")
}

var _ Adapter = (*duckDBAdapter)(nil)
