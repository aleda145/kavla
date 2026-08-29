package sources

import (
	"context"
	"fmt"
	"strings"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
)

type postgresAdapter struct {
	sourceName string
	connection string
}

var postgresStartupSQL = []string{
	"INSTALL postgres",
	"LOAD postgres",
}

func (postgresAdapter) Type() string {
	return "postgres"
}

func (postgresAdapter) StartupRequirements(src kavlaconfig.SourceConfig) (*StartupRequirements, error) {
	return &StartupRequirements{}, nil
}

func (p *postgresAdapter) Validate(ctx context.Context, name string, src kavlaconfig.SourceConfig) error {
	p.sourceName = name
	p.connection = strings.TrimSpace(src.Connection)
	_, err := p.ListTables(ctx)
	return err
}

func (p *postgresAdapter) Init(ctx context.Context, reg RegistrationContext, name string, src kavlaconfig.SourceConfig) error {
	p.sourceName = name
	p.connection = strings.TrimSpace(src.Connection)
	if err := execSourceSQL(ctx, reg, postgresStartupSQL); err != nil {
		return fmt.Errorf("load postgres extension: %w", err)
	}

	attachSQL := postgresAttachSQL(name, p.connection)
	if reg.ExecSQL != nil {
		if err := reg.ExecSQL(fmt.Sprintf("Attach Postgres source '%s'", name), attachSQL); err != nil {
			return err
		}
	} else if _, err := reg.DB.ExecContext(ctx, attachSQL); err != nil {
		return fmt.Errorf("ATTACH postgres: %w", err)
	}
	reg.Logf("Source '%s' (postgres): attached in READ_ONLY mode\n", name)
	return nil
}

func (p *postgresAdapter) ListTables(ctx context.Context) ([]string, error) {
	if strings.TrimSpace(p.connection) == "" {
		return nil, fmt.Errorf("postgres source connection is required")
	}
	return listCatalogObjectsIsolated(ctx, postgresStartupSQL, postgresAttachSQL(isolatedCatalogName, p.connection), p.sourceName)
}

func (postgresAdapter) PreparePreviewSQL(sourceName, sql string, limit int) (string, error) {
	escapedSQL := strings.ReplaceAll(sql, "'", "''")
	if limit <= 0 {
		return fmt.Sprintf("SELECT * FROM postgres_query('%s', '%s')", sourceName, escapedSQL), nil
	}
	return fmt.Sprintf("SELECT * FROM postgres_query('%s', '%s') LIMIT %d", sourceName, escapedSQL, limit), nil
}

func (p *postgresAdapter) DescribeTableSQL(tableRef string) (string, bool, error) {
	tablePath, ok := sourceTablePath(p.sourceName, tableRef)
	if !ok {
		return "", false, nil
	}
	return fmt.Sprintf("DESCRIBE %s", doubleQuotedQualified(append([]string{p.sourceName}, tablePath...))), true, nil
}

func (p *postgresAdapter) SourceStatsSQL(tableRef string) (string, bool, error) {
	tablePath, ok := sourceTablePath(p.sourceName, tableRef)
	if !ok {
		return "", false, nil
	}
	return fmt.Sprintf("SELECT COUNT(*) FROM %s", doubleQuotedQualified(append([]string{p.sourceName}, tablePath...))), true, nil
}

func (p *postgresAdapter) ExportTableSQL(tableRef string) (string, bool, error) {
	tablePath, ok := sourceTablePath(p.sourceName, tableRef)
	if !ok {
		return "", false, nil
	}
	return fmt.Sprintf("SELECT * FROM %s", doubleQuotedQualified(append([]string{p.sourceName}, tablePath...))), true, nil
}

func postgresAttachSQL(catalogName, connection string) string {
	return fmt.Sprintf(
		`ATTACH %s AS "%s" (TYPE postgres, READ_ONLY)`,
		sqlSingleQuoted(connection),
		strings.ReplaceAll(catalogName, `"`, `""`),
	)
}

var _ Adapter = (*postgresAdapter)(nil)
