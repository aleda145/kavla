package engine

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"fmt"
	"log"
	"slices"
	"strings"
	"time"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
	"github.com/aleda145/kavla/cli/internal/sources"
	"github.com/apache/arrow/go/v14/arrow"
	"github.com/apache/arrow/go/v14/arrow/array"
	"github.com/apache/arrow/go/v14/arrow/memory"
	_ "github.com/duckdb/duckdb-go/v2"
)

type Engine struct {
	db              *sql.DB
	logf            func(string, ...interface{})
	adapterRegistry map[string]sources.AdapterFactory
	adapters        map[string]sources.Adapter
	sourceStatuses  map[string]SourceStatus
}

type SourceStatus struct {
	Name      string
	Type      string
	Available bool
	Error     string
}

type ResultColumn struct {
	Name string
	Type string
}

// New creates a new in-memory DuckDB engine and initializes all configured sources.
func New(sourceConfigs map[string]kavlaconfig.SourceConfig, logf func(string, ...interface{})) (*Engine, error) {
	return NewWithAllowedDirectories(sourceConfigs, logf, nil)
}

func NewWithAllowedDirectories(sourceConfigs map[string]kavlaconfig.SourceConfig, logf func(string, ...interface{}), additionalDirectories []string) (*Engine, error) {
	if logf == nil {
		logf = log.Printf
	}

	db, err := sql.Open("duckdb", ":memory:")
	if err != nil {
		return nil, fmt.Errorf("failed to open in-memory DuckDB: %w", err)
	}
	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("failed to ping DuckDB: %w", err)
	}
	db.SetMaxOpenConns(5)

	e := &Engine{
		db:              db,
		logf:            logf,
		adapterRegistry: sources.BuiltIn(),
		adapters:        make(map[string]sources.Adapter),
		sourceStatuses:  make(map[string]SourceStatus),
	}

	if err := e.initializeStartup(context.Background(), sourceConfigs, additionalDirectories); err != nil {
		_ = db.Close()
		return nil, err
	}

	return e, nil
}

func (e *Engine) initializeStartup(ctx context.Context, sourceConfigs map[string]kavlaconfig.SourceConfig, additionalDirectories []string) error {
	sourceNames := make([]string, 0, len(sourceConfigs))
	for name := range sourceConfigs {
		sourceNames = append(sourceNames, name)
	}
	slices.Sort(sourceNames)

	dirSet := make(map[string]struct{})
	for _, dir := range additionalDirectories {
		dir = strings.TrimSpace(dir)
		if dir != "" {
			dirSet[dir] = struct{}{}
		}
	}
	pathSet := make(map[string]struct{})
	reg := sources.RegistrationContext{
		DB:   e.db,
		Logf: e.logf,
		ExecSQL: func(label, sql string) error {
			return e.execStartupSQL(ctx, sql)
		},
	}

	for _, name := range sourceNames {
		src := sourceConfigs[name]
		status := SourceStatus{Name: name, Type: src.Type}

		adapter, err := e.getAdapterForType(src.Type)
		if err != nil {
			e.markSourceUnavailable(status, err)
			continue
		}

		requirements, err := adapter.StartupRequirements(src)
		if err != nil {
			e.markSourceUnavailable(status, err)
			continue
		}

		if err := adapter.Validate(ctx, name, src); err != nil {
			e.markSourceUnavailable(status, err)
			continue
		}

		if err := adapter.Init(ctx, reg, name, src); err != nil {
			e.markSourceUnavailable(status, err)
			continue
		}

		for _, dir := range requirements.AllowedDirectories {
			dirSet[dir] = struct{}{}
		}
		for _, path := range requirements.AllowedPaths {
			pathSet[path] = struct{}{}
		}

		status.Available = true
		e.adapters[name] = adapter
		e.sourceStatuses[name] = status
	}

	allowedDirectories := make([]string, 0, len(dirSet))
	for dir := range dirSet {
		allowedDirectories = append(allowedDirectories, dir)
	}
	slices.Sort(allowedDirectories)

	allowedPaths := make([]string, 0, len(pathSet))
	for path := range pathSet {
		allowedPaths = append(allowedPaths, path)
	}
	slices.Sort(allowedPaths)

	sql := fmt.Sprintf("SET allowed_directories = %s", sqlStringList(allowedDirectories))
	if err := e.execStartupSQL(ctx, sql); err != nil {
		return err
	}

	sql = fmt.Sprintf("SET allowed_paths = %s", sqlStringList(allowedPaths))
	if err := e.execStartupSQL(ctx, sql); err != nil {
		return err
	}

	if err := e.execStartupSQL(ctx, "SET lock_configuration = true"); err != nil {
		return err
	}
	e.logf("DuckDB configuration locked\n")

	e.logf("DuckDB startup ready\n")
	return nil
}

func (e *Engine) markSourceUnavailable(status SourceStatus, err error) {
	status.Available = false
	status.Error = err.Error()
	e.sourceStatuses[status.Name] = status
	e.logf("Source '%s' (%s): unavailable: %v\n", status.Name, status.Type, err)
}

func (e *Engine) execStartupSQL(ctx context.Context, sql string) error {
	if _, err := e.db.ExecContext(ctx, sql); err != nil {
		return err
	}
	return nil
}

func sqlStringList(values []string) string {
	quoted := make([]string, 0, len(values))
	for _, value := range values {
		quoted = append(quoted, "'"+strings.ReplaceAll(value, "'", "''")+"'")
	}
	return "[" + strings.Join(quoted, ", ") + "]"
}

func (e *Engine) SourceStatuses() []SourceStatus {
	names := make([]string, 0, len(e.sourceStatuses))
	for name := range e.sourceStatuses {
		names = append(names, name)
	}
	slices.Sort(names)

	statuses := make([]SourceStatus, 0, len(names))
	for _, name := range names {
		statuses = append(statuses, e.sourceStatuses[name])
	}
	return statuses
}

func (e *Engine) unavailableSourceError(sourceName string) error {
	sourceName = strings.TrimSpace(sourceName)
	if sourceName == "" {
		return fmt.Errorf("source name is required")
	}

	status, ok := e.sourceStatuses[sourceName]
	if !ok {
		return fmt.Errorf("unknown source: %s", sourceName)
	}
	if !status.Available {
		if status.Error != "" {
			return fmt.Errorf("%s", status.Error)
		}
		return fmt.Errorf("source '%s' is unavailable", sourceName)
	}
	return nil
}

func (e *Engine) ensureSourceAvailable(sourceName string) error {
	return e.unavailableSourceError(sourceName)
}

func (e *Engine) ensureConfiguredSourceHealthy(sourceName string) error {
	sourceName = strings.TrimSpace(sourceName)
	if sourceName == "" {
		return nil
	}
	status, ok := e.sourceStatuses[sourceName]
	if !ok {
		return nil
	}
	if status.Available {
		return nil
	}
	if status.Error != "" {
		return fmt.Errorf("%s", status.Error)
	}
	return fmt.Errorf("source '%s' is unavailable", sourceName)
}

func (e *Engine) Query(ctx context.Context, query string) (array.RecordReader, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	if err := e.ensureDeferredTables(ctx, query); err != nil {
		return nil, err
	}

	rows, err := e.db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	colTypes, err := rows.ColumnTypes()
	if err != nil {
		return nil, err
	}

	fields := make([]arrow.Field, len(colTypes))
	for i, ct := range colTypes {
		fields[i] = arrow.Field{Name: ct.Name(), Type: getArrowType(ct.DatabaseTypeName())}
	}
	schema := arrow.NewSchema(fields, nil)

	mem := memory.NewGoAllocator()
	b := array.NewRecordBuilder(mem, schema)
	defer b.Release()

	values := make([]interface{}, len(colTypes))
	scanArgs := make([]interface{}, len(colTypes))
	for i := range values {
		scanArgs[i] = &values[i]
	}

	for rows.Next() {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if err := rows.Scan(scanArgs...); err != nil {
			return nil, err
		}

		for i, val := range values {
			if val == nil {
				b.Field(i).AppendNull()
				continue
			}

			switch b.Field(i).Type().(type) {
			case *arrow.Int64Type:
				var v int64
				switch t := val.(type) {
				case int64:
					v = t
				case int:
					v = int64(t)
				case int32:
					v = int64(t)
				case int16:
					v = int64(t)
				case int8:
					v = int64(t)
				case float64:
					v = int64(t)
				default:
					v = 0
				}
				b.Field(i).(*array.Int64Builder).Append(v)

			case *arrow.Float64Type:
				var v float64
				switch t := val.(type) {
				case float64:
					v = t
				case float32:
					v = float64(t)
				default:
					v = 0.0
				}
				b.Field(i).(*array.Float64Builder).Append(v)

			case *arrow.StringType:
				var s string
				switch v := val.(type) {
				case string:
					s = v
				case []byte:
					s = string(v)
				case time.Time:
					s = v.Format(time.RFC3339)
				default:
					s = fmt.Sprintf("%v", v)
				}
				b.Field(i).(*array.StringBuilder).Append(s)

			default:
				b.Field(i).(*array.StringBuilder).Append(fmt.Sprintf("%v", val))
			}
		}
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	rec := b.NewRecord()
	return array.NewRecordReader(schema, []arrow.Record{rec})
}

func resultTableName(resultID string) string {
	digest := sha256.Sum256([]byte(resultID))
	return fmt.Sprintf("_kavla_result_%x", digest[:16])
}

func (e *Engine) CreateResultView(ctx context.Context, resultID, query string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(resultID) == "" {
		return fmt.Errorf("result id is required")
	}
	if err := e.ensureDeferredTables(ctx, query); err != nil {
		return err
	}
	_, err := e.db.ExecContext(ctx, fmt.Sprintf(
		"CREATE OR REPLACE VIEW %s AS %s",
		quoteIdentifier(resultTableName(resultID)),
		query,
	))
	return err
}

func (e *Engine) ResultRowCount(ctx context.Context, resultID string) (int64, error) {
	var count int64
	err := e.db.QueryRowContext(ctx, fmt.Sprintf(
		"SELECT COUNT(*) FROM %s",
		quoteIdentifier(resultTableName(resultID)),
	)).Scan(&count)
	return count, err
}

func (e *Engine) ResultSchema(ctx context.Context, resultID string) ([]ResultColumn, error) {
	rows, err := e.db.QueryContext(ctx, fmt.Sprintf(
		"DESCRIBE SELECT * FROM %s",
		quoteIdentifier(resultTableName(resultID)),
	))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns := []ResultColumn{}
	for rows.Next() {
		var name, columnType, nullable string
		var key, defaultValue, extra interface{}
		if err := rows.Scan(&name, &columnType, &nullable, &key, &defaultValue, &extra); err != nil {
			return nil, err
		}
		columns = append(columns, ResultColumn{Name: name, Type: columnType})
	}
	return columns, rows.Err()
}

func (e *Engine) QueryResultPage(ctx context.Context, resultID string, offset, limit int) (array.RecordReader, error) {
	if offset < 0 {
		return nil, fmt.Errorf("result offset must not be negative")
	}
	if limit < 1 {
		return nil, fmt.Errorf("result limit must be positive")
	}
	return e.Query(ctx, fmt.Sprintf(
		"SELECT * FROM %s LIMIT %d OFFSET %d",
		quoteIdentifier(resultTableName(resultID)),
		limit,
		offset,
	))
}

func (e *Engine) ExportResult(ctx context.Context, resultID, format, outputPath string) error {
	var copyOptions string
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "csv":
		copyOptions = "FORMAT CSV, HEADER true"
	case "parquet":
		copyOptions = "FORMAT PARQUET, COMPRESSION SNAPPY"
	default:
		return fmt.Errorf("unsupported query result export format: %s", format)
	}

	copySQL := fmt.Sprintf(
		"COPY (SELECT * FROM %s) TO %s (%s)",
		quoteIdentifier(resultTableName(resultID)),
		sqlStringLiteral(outputPath),
		copyOptions,
	)
	if _, err := e.db.ExecContext(ctx, copySQL); err != nil {
		return fmt.Errorf("export query result: %w", err)
	}
	return nil
}

func (e *Engine) DropResult(ctx context.Context, resultID string) error {
	_, err := e.db.ExecContext(ctx, fmt.Sprintf(
		"DROP VIEW IF EXISTS %s",
		quoteIdentifier(resultTableName(resultID)),
	))
	return err
}

func (e *Engine) GetTables(sourceName string) ([]string, error) {
	if err := e.ensureSourceAvailable(sourceName); err != nil {
		return nil, err
	}

	adapter, ok := e.adapters[sourceName]
	if !ok {
		return nil, fmt.Errorf("unknown source: %s", sourceName)
	}

	tables, err := adapter.ListTables(context.Background())
	if err != nil {
		return nil, err
	}

	log.Printf("[Engine] GetTables found %d tables for source %s", len(tables), sourceName)
	return tables, nil
}

func (e *Engine) Close() error {
	return e.db.Close()
}

func (e *Engine) ensureDeferredTables(ctx context.Context, query string) error {
	for _, adapter := range e.adapters {
		materializer, ok := adapter.(sources.DeferredTableMaterializer)
		if !ok {
			continue
		}
		if err := materializer.MaterializeReferencedTables(ctx, query, func(sql string) error {
			_, err := e.db.ExecContext(ctx, sql)
			return err
		}); err != nil {
			return err
		}
	}
	return nil
}

func getArrowType(dbType string) arrow.DataType {
	switch dbType {
	case "BIGINT", "INTEGER", "INT", "INT8", "INT4":
		return arrow.PrimitiveTypes.Int64
	case "DOUBLE", "FLOAT", "FLOAT8":
		return arrow.PrimitiveTypes.Float64
	default:
		return arrow.BinaryTypes.String
	}
}
