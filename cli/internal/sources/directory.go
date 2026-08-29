package sources

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
)

type deferredTable struct {
	ref       string
	matchName string
	createSQL string
}

type directoryAdapter struct {
	logf          func(string, ...interface{})
	sourceName    string
	absDir        string
	mu            sync.Mutex
	pendingTables map[string]deferredTable
	tableRefs     []string
}

func (*directoryAdapter) Type() string {
	return "directory"
}

func (*directoryAdapter) StartupRequirements(src kavlaconfig.SourceConfig) (*StartupRequirements, error) {
	absDir, err := filepath.Abs(src.Connection)
	if err != nil {
		return nil, fmt.Errorf("resolve directory path: %w", err)
	}
	return &StartupRequirements{
		AllowedDirectories: []string{filepath.Clean(absDir)},
	}, nil
}

func (d *directoryAdapter) Validate(ctx context.Context, name string, src kavlaconfig.SourceConfig) error {
	absDir, err := filepath.Abs(src.Connection)
	if err != nil {
		return fmt.Errorf("resolve directory path: %w", err)
	}
	pendingTables, tableRefs, err := buildDeferredTables(absDir, name)
	if err != nil {
		return err
	}

	d.mu.Lock()
	d.sourceName = name
	d.absDir = absDir
	d.pendingTables = pendingTables
	d.tableRefs = tableRefs
	d.mu.Unlock()
	return nil
}

func (d *directoryAdapter) Init(ctx context.Context, reg RegistrationContext, name string, src kavlaconfig.SourceConfig) error {
	if d.sourceName != name || d.absDir == "" {
		if err := d.Validate(ctx, name, src); err != nil {
			return err
		}
	}

	d.logf = reg.Logf
	schemaSQL := fmt.Sprintf("CREATE SCHEMA \"%s\"", name)
	if reg.ExecSQL != nil {
		if err := reg.ExecSQL(fmt.Sprintf("Create schema for directory source '%s'", name), schemaSQL); err != nil {
			return err
		}
	} else if _, err := reg.DB.ExecContext(ctx, schemaSQL); err != nil {
		return fmt.Errorf("CREATE SCHEMA: %w", err)
	}

	reg.Logf("Source '%s' (directory): attached in READ_ONLY mode\n", name)
	return nil
}

func buildDeferredTables(absDir, sourceName string) (map[string]deferredTable, []string, error) {
	pendingTables := make(map[string]deferredTable)
	tableRefs := make([]string, 0)
	usedTableNames := make(map[string]int)

	err := filepath.WalkDir(absDir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}

		ext := strings.ToLower(filepath.Ext(path))
		var viewSQL string
		if ext != ".parquet" && ext != ".csv" && ext != ".json" && ext != ".ndjson" {
			return nil
		}

		relPath, err := filepath.Rel(absDir, path)
		if err != nil {
			return nil
		}
		baseName := directoryTableName(strings.TrimSuffix(filepath.ToSlash(relPath), filepath.Ext(relPath)))
		usedTableNames[baseName]++
		if usedTableNames[baseName] > 1 {
			baseName = fmt.Sprintf("%s_%d", baseName, usedTableNames[baseName])
		}

		switch ext {
		case ".parquet":
			viewSQL = fmt.Sprintf("CREATE VIEW \"%s\".\"%s\" AS SELECT * FROM '%s'", sourceName, baseName, path)
		case ".csv":
			viewSQL = fmt.Sprintf("CREATE VIEW \"%s\".\"%s\" AS SELECT * FROM read_csv_auto('%s')", sourceName, baseName, path)
		case ".json", ".ndjson":
			viewSQL = fmt.Sprintf("CREATE VIEW \"%s\".\"%s\" AS SELECT * FROM read_json_auto('%s')", sourceName, baseName, path)
		default:
			return nil
		}

		tableRef := sourceName + "." + baseName
		pendingTables[tableRef] = deferredTable{
			ref:       tableRef,
			matchName: baseName,
			createSQL: viewSQL,
		}
		tableRefs = append(tableRefs, tableRef)
		return nil
	})
	if err != nil {
		return nil, nil, fmt.Errorf("walk directory '%s': %w", absDir, err)
	}

	slices.Sort(tableRefs)
	return pendingTables, tableRefs, nil
}

func directoryTableName(relativePath string) string {
	var name strings.Builder
	previousUnderscore := false
	for _, character := range relativePath {
		isLetter := character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z'
		isNumber := character >= '0' && character <= '9'
		if isLetter || isNumber {
			name.WriteRune(character)
			previousUnderscore = false
			continue
		}
		if !previousUnderscore {
			name.WriteByte('_')
			previousUnderscore = true
		}
	}

	tableName := strings.Trim(name.String(), "_")
	if tableName == "" {
		return "table"
	}
	return tableName
}

func (d *directoryAdapter) ListTables(ctx context.Context) ([]string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.tableRefs...), nil
}

func (*directoryAdapter) PreparePreviewSQL(sourceName, sql string, limit int) (string, error) {
	return DefaultPreviewSQL(sourceName, sql, limit)
}

func (d *directoryAdapter) DescribeTableSQL(tableRef string) (string, bool, error) {
	tablePath, ok := sourceTablePath(d.sourceName, tableRef)
	if !ok {
		return "", false, nil
	}
	return fmt.Sprintf("DESCRIBE %s", doubleQuotedQualified(append([]string{d.sourceName}, tablePath...))), true, nil
}

func (d *directoryAdapter) SourceStatsSQL(tableRef string) (string, bool, error) {
	tablePath, ok := sourceTablePath(d.sourceName, tableRef)
	if !ok {
		return "", false, nil
	}
	return fmt.Sprintf("SELECT COUNT(*) FROM %s", doubleQuotedQualified(append([]string{d.sourceName}, tablePath...))), true, nil
}

func (d *directoryAdapter) ExportTableSQL(tableRef string) (string, bool, error) {
	tablePath, ok := sourceTablePath(d.sourceName, tableRef)
	if !ok {
		return "", false, nil
	}
	return fmt.Sprintf("SELECT * FROM %s", doubleQuotedQualified(append([]string{d.sourceName}, tablePath...))), true, nil
}

func (d *directoryAdapter) MaterializeReferencedTables(ctx context.Context, query string, exec func(string) error) error {
	queryLower := strings.ToLower(query)
	d.mu.Lock()
	defer d.mu.Unlock()

	for key, table := range d.pendingTables {
		if !strings.Contains(queryLower, strings.ToLower(table.matchName)) {
			continue
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if d.logf != nil {
			d.logf("Lazily initializing view: %s\n", table.ref)
		}
		if err := exec(table.createSQL); err != nil {
			return fmt.Errorf("initialize view %s: %w", table.ref, err)
		}
		delete(d.pendingTables, key)
	}

	return nil
}

var _ Adapter = (*directoryAdapter)(nil)
var _ DeferredTableMaterializer = (*directoryAdapter)(nil)
