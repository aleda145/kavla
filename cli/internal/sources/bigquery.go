package sources

import (
	"context"
	"fmt"
	"strings"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
)

type bigQueryAdapter struct {
	sourceName string
	connection string
}

var bigQueryStartupSQL = []string{
	"INSTALL bigquery FROM community",
	"LOAD bigquery",
}

func (bigQueryAdapter) Type() string {
	return "bigquery"
}

func (bigQueryAdapter) StartupRequirements(src kavlaconfig.SourceConfig) (*StartupRequirements, error) {
	return &StartupRequirements{}, nil
}

func normalizeBigQueryConnection(connection string) string {
	connStr := strings.TrimSpace(connection)
	if !strings.Contains(connStr, "project=") {
		connStr = "project=" + connStr
	}
	return connStr
}

func execSourceSQL(ctx context.Context, reg RegistrationContext, statements []string) error {
	for _, sql := range statements {
		if reg.ExecSQL != nil {
			if err := reg.ExecSQL("", sql); err != nil {
				return err
			}
			continue
		}
		if _, err := reg.DB.ExecContext(ctx, sql); err != nil {
			return err
		}
	}
	return nil
}

func (b *bigQueryAdapter) Validate(ctx context.Context, name string, src kavlaconfig.SourceConfig) error {
	b.sourceName = name
	b.connection = normalizeBigQueryConnection(src.Connection)
	_, err := b.ListTables(ctx)
	return err
}

func (b *bigQueryAdapter) Init(ctx context.Context, reg RegistrationContext, name string, src kavlaconfig.SourceConfig) error {
	b.sourceName = name
	b.connection = normalizeBigQueryConnection(src.Connection)
	if err := execSourceSQL(ctx, reg, bigQueryStartupSQL); err != nil {
		return fmt.Errorf("load bigquery extension: %w", err)
	}

	attachSQL := fmt.Sprintf("ATTACH %s AS \"%s\" (TYPE bigquery, READ_ONLY)", sqlSingleQuoted(b.connection), name)
	if reg.ExecSQL != nil {
		if err := reg.ExecSQL(fmt.Sprintf("Attach BigQuery source '%s'", name), attachSQL); err != nil {
			return err
		}
	} else if _, err := reg.DB.ExecContext(ctx, attachSQL); err != nil {
		return fmt.Errorf("ATTACH bigquery: %w", err)
	}
	reg.Logf("Source '%s' (bigquery): attached in READ_ONLY mode\n", name)
	return nil
}

func (b *bigQueryAdapter) ListTables(ctx context.Context) ([]string, error) {
	if strings.TrimSpace(b.connection) == "" {
		return nil, fmt.Errorf("bigquery source connection is required")
	}
	attachSQL := fmt.Sprintf("ATTACH %s AS \"%s\" (TYPE bigquery, READ_ONLY)", sqlSingleQuoted(b.connection), isolatedCatalogName)
	return listCatalogObjectsIsolated(ctx, bigQueryStartupSQL, attachSQL, b.sourceName)
}

func (bigQueryAdapter) PreparePreviewSQL(sourceName, sql string, limit int) (string, error) {
	escapedSQL := strings.ReplaceAll(sql, "'", "''")
	if limit <= 0 {
		return fmt.Sprintf("SELECT * FROM bigquery_query('%s', '%s')", sourceName, escapedSQL), nil
	}
	return fmt.Sprintf("SELECT * FROM bigquery_query('%s', '%s') LIMIT %d", sourceName, escapedSQL, limit), nil
}

// TODO
// something like:
// SELECT column_name, is_nullable, data_type
// FROM `bigquery-public-data.austin_311.INFORMATION_SCHEMA.COLUMNS`
// WHERE table_name="311_request"
// is probably better

func (b *bigQueryAdapter) DescribeTableSQL(tableRef string) (string, bool, error) {
	tablePath, ok := sourceTablePath(b.sourceName, tableRef)
	if !ok {
		return "", false, nil
	}
	query := fmt.Sprintf("SELECT * FROM %s LIMIT 0", backtickQualified(tablePath))
	wrappedSQL, err := b.PreparePreviewSQL(b.sourceName, query, 10000)
	if err != nil {
		return "", false, err
	}
	return fmt.Sprintf("DESCRIBE %s", wrappedSQL), true, nil
}

// TODO querying the information schema is probably also better here

func (b *bigQueryAdapter) SourceStatsSQL(tableRef string) (string, bool, error) {
	tablePath, ok := sourceTablePath(b.sourceName, tableRef)
	if !ok {
		return "", false, nil
	}
	query := fmt.Sprintf("SELECT COUNT(*) AS row_count FROM %s", backtickQualified(tablePath))
	wrappedSQL, err := b.PreparePreviewSQL(b.sourceName, query, 10000)
	if err != nil {
		return "", false, err
	}
	return fmt.Sprintf("SELECT row_count FROM (%s)", wrappedSQL), true, nil
}

func (b *bigQueryAdapter) ExportTableSQL(tableRef string) (string, bool, error) {
	tablePath, ok := sourceTablePath(b.sourceName, tableRef)
	if !ok {
		return "", false, nil
	}
	query := fmt.Sprintf("SELECT * FROM %s", backtickQualified(tablePath))
	wrappedSQL, err := b.PreparePreviewSQL(b.sourceName, query, 0)
	if err != nil {
		return "", false, err
	}
	return wrappedSQL, true, nil
}

func backtickQualified(parts []string) string {
	quoted := make([]string, 0, len(parts))
	for _, part := range parts {
		quoted = append(quoted, "`"+strings.ReplaceAll(part, "`", "``")+"`")
	}
	return strings.Join(quoted, ".")
}

var _ Adapter = (*bigQueryAdapter)(nil)
