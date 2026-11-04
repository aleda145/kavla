package engine

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"slices"
	"strings"
	"time"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
	"github.com/aleda145/kavla/cli/internal/memoryguard"
	"github.com/aleda145/kavla/cli/internal/sources"
	"github.com/aleda145/kavla/cli/internal/spilldir"
	"github.com/apache/arrow/go/v14/arrow"
	"github.com/apache/arrow/go/v14/arrow/array"
	"github.com/apache/arrow/go/v14/arrow/memory"
	_ "github.com/duckdb/duckdb-go/v2"
)

type Engine struct {
	db                  *sql.DB
	spillDir            *spilldir.Directory
	logf                func(string, ...interface{})
	adapterRegistry     map[string]sources.AdapterFactory
	adapters            map[string]sources.Adapter
	sourceStatuses      map[string]SourceStatus
	sourceConfigs       map[string]kavlaconfig.SourceConfig
	sourceStatusChanged func(SourceStatus)
	uploads             map[string]uploadedFile
}

type SourceStatus struct {
	Name      string
	Type      string
	Available bool
	Loading   bool
	Revision  uint64
	Error     string
}

type ResultColumn struct {
	Name string
	Type string
}

// New creates a disk-backed DuckDB engine and initializes all configured sources.
func New(sourceConfigs map[string]kavlaconfig.SourceConfig, logf func(string, ...interface{})) (*Engine, error) {
	return NewWithAllowedDirectories(sourceConfigs, logf, nil)
}

func NewWithAllowedDirectories(sourceConfigs map[string]kavlaconfig.SourceConfig, logf func(string, ...interface{}), additionalDirectories []string) (result *Engine, resultErr error) {
	e, err := NewLazyWithAllowedDirectories(sourceConfigs, logf, additionalDirectories)
	if err != nil {
		return nil, err
	}
	e.InitializeSources(context.Background())
	return e, nil
}

// NewLazyWithAllowedDirectories configures DuckDB without connecting sources.
// Source paths are collected before locking configuration; validation, directory
// scans, extension loading and catalog attachment happen only on first use.
func NewLazyWithAllowedDirectories(sourceConfigs map[string]kavlaconfig.SourceConfig, logf func(string, ...interface{}), additionalDirectories []string) (result *Engine, resultErr error) {
	if logf == nil {
		logf = log.Printf
	}
	spill, err := spilldir.New()
	if err != nil {
		return nil, err
	}
	defer func() {
		if result == nil {
			resultErr = errors.Join(resultErr, spill.Close())
		}
	}()

	// Preserve the default catalog name used by existing SQL references. Despite
	// its name, memory.duckdb is a regular file in the managed session directory.
	db, err := sql.Open("duckdb", spill.DatabasePath("memory"))
	if err != nil {
		return nil, fmt.Errorf("failed to open disk-backed DuckDB: %w", err)
	}
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("failed to ping DuckDB: %w", err)
	}
	if err := spill.Configure(db); err != nil {
		_ = db.Close()
		return nil, err
	}
	if limit := memoryguard.DuckDBLimit(); limit > 0 {
		if _, err := db.Exec(fmt.Sprintf("SET memory_limit = '%dB'", limit)); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("set DuckDB memory budget: %w", err)
		}
	}
	db.SetMaxOpenConns(5)
	if _, err := db.Exec("ATTACH " + sqlStringLiteral(spill.DatabasePath(UploadedFilesSource)) + " AS uploaded_files"); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("open uploaded files catalog: %w", err)
	}

	e := &Engine{
		db:              db,
		spillDir:        spill,
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
	e.sourceConfigs = make(map[string]kavlaconfig.SourceConfig, len(sourceConfigs))
	for name := range sourceConfigs {
		if strings.EqualFold(name, UploadedFilesSource) {
			return fmt.Errorf("source name uploaded_files is reserved for document uploads")
		}
	}
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
	for _, name := range sourceNames {
		src := sourceConfigs[name]
		e.sourceConfigs[name] = src
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

		for _, dir := range requirements.AllowedDirectories {
			dirSet[dir] = struct{}{}
		}
		for _, path := range requirements.AllowedPaths {
			pathSet[path] = struct{}{}
		}

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
	status.Loading = false
	status.Error = err.Error()
	status.Revision++
	e.sourceStatuses[status.Name] = status
	if e.sourceStatusChanged != nil {
		e.sourceStatusChanged(status)
	}
	e.logf("Source '%s' (%s): unavailable: %v\n", status.Name, status.Type, err)
}

func (e *Engine) SetSourceStatusHandler(handler func(SourceStatus)) {
	e.sourceStatusChanged = handler
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

// InitializeSources retains connection checks for explicitly eager sessions.
// Local and cloud canvas workers do not call it at startup.
func (e *Engine) InitializeSources(ctx context.Context) {
	for _, status := range e.SourceStatuses() {
		_ = e.ensureSourceAvailable(ctx, status.Name)
	}
}

func (e *Engine) ensureSourceAvailable(ctx context.Context, sourceName string) error {
	for name := range e.sourceConfigs {
		if strings.EqualFold(name, sourceName) {
			sourceName = name
			break
		}
	}
	status, exists := e.sourceStatuses[sourceName]
	if !exists || status.Available || status.Error != "" {
		return e.unavailableSourceError(sourceName)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	status.Loading = true
	status.Revision++
	e.sourceStatuses[sourceName] = status
	if e.sourceStatusChanged != nil {
		e.sourceStatusChanged(status)
	}
	src := e.sourceConfigs[sourceName]
	adapter, err := e.getAdapterForType(src.Type)
	if err == nil {
		err = adapter.Validate(ctx, sourceName, src)
	}
	if err == nil {
		err = adapter.Init(ctx, sources.RegistrationContext{
			DB: e.db, Logf: e.logf,
			ExecSQL: func(label, sql string) error { return e.execStartupSQL(ctx, sql) },
		}, sourceName, src)
	}
	if err != nil {
		e.markSourceUnavailable(status, err)
		return fmt.Errorf("initialize source %q: %w", sourceName, err)
	}
	status.Loading = false
	status.Available = true
	status.Revision++
	e.adapters[sourceName] = adapter
	e.sourceStatuses[sourceName] = status
	if e.sourceStatusChanged != nil {
		e.sourceStatusChanged(status)
	}
	return nil
}

func (e *Engine) ensureConfiguredSourceHealthy(ctx context.Context, sourceName string) error {
	sourceName = strings.TrimSpace(sourceName)
	if sourceName == "" {
		return nil
	}
	for name := range e.sourceConfigs {
		if strings.EqualFold(name, sourceName) {
			return e.ensureSourceAvailable(ctx, name)
		}
	}
	return nil
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

	return rowsToArrow(ctx, rows)
}

func rowsToArrow(ctx context.Context, rows *sql.Rows) (array.RecordReader, error) {
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
	// Keep individual IPC batches bounded when results cross into the canvas
	// server. The full result is still owned by the memory-limited worker.
	var records []arrow.Record
	defer func() {
		for _, record := range records {
			record.Release()
		}
	}()
	batchRows, batchBytes := 0, 0

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

		rowStartBytes := batchBytes
		for i, val := range values {
			batchBytes += 16
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
				case uint8:
					v = int64(t)
				case uint16:
					v = int64(t)
				case uint32:
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

			case *arrow.BooleanType:
				value, ok := val.(bool)
				if !ok {
					return nil, fmt.Errorf("invalid boolean value in %s", fields[i].Name)
				}
				b.Field(i).(*array.BooleanBuilder).Append(value)

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
				if len(s) > 8<<20 {
					return nil, fmt.Errorf("result value in %s exceeds the 8 MiB transfer limit; export the result to a file instead", fields[i].Name)
				}
				batchBytes += len(s)
				b.Field(i).(*array.StringBuilder).Append(s)

			default:
				b.Field(i).(*array.StringBuilder).Append(fmt.Sprintf("%v", val))
			}
		}
		batchRows++
		if batchBytes-rowStartBytes > 8<<20 {
			return nil, fmt.Errorf("result row exceeds the 8 MiB transfer limit; export the result to a file instead")
		}
		if batchRows >= 512 || batchBytes >= 1<<20 {
			records = append(records, b.NewRecord())
			batchRows, batchBytes = 0, 0
		}
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	if batchRows > 0 || len(records) == 0 {
		records = append(records, b.NewRecord())
	}
	return array.NewRecordReader(schema, records)
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
	case "tsv":
		copyOptions = "FORMAT CSV, HEADER true, DELIMITER '\t'"
	case "csv":
		copyOptions = "FORMAT CSV, HEADER true"
	case "parquet":
		copyOptions = "FORMAT PARQUET, COMPRESSION SNAPPY"
	case "json":
		copyOptions = "FORMAT JSON, ARRAY true"
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
	return e.GetTablesContext(context.Background(), sourceName)
}

func (e *Engine) GetTablesContext(ctx context.Context, sourceName string) ([]string, error) {
	if sourceName == UploadedFilesSource {
		return e.uploadedTables(ctx)
	}
	if err := e.ensureSourceAvailable(ctx, sourceName); err != nil {
		return nil, err
	}

	adapter, ok := e.adapters[sourceName]
	if !ok {
		return nil, fmt.Errorf("unknown source: %s", sourceName)
	}

	tables, err := adapter.ListTables(ctx)
	if err != nil {
		return nil, err
	}

	log.Printf("[Engine] GetTables found %d tables for source %s", len(tables), sourceName)
	return tables, nil
}

func (e *Engine) Close() error {
	if err := e.db.Close(); err != nil {
		return err
	}
	if e.spillDir != nil {
		return e.spillDir.Close()
	}
	return nil
}

func (e *Engine) ensureDeferredTables(ctx context.Context, query string) error {
	if err := e.ensureReferencedSources(ctx, query); err != nil {
		return err
	}
	if err := e.ensureUploadedFiles(ctx, query); err != nil {
		return err
	}
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
	case "BIGINT", "INTEGER", "INT", "INT8", "INT4", "TINYINT", "SMALLINT", "UTINYINT", "USMALLINT", "UINTEGER":
		return arrow.PrimitiveTypes.Int64
	case "BOOLEAN":
		return arrow.FixedWidthTypes.Boolean
	case "DOUBLE", "FLOAT", "FLOAT8":
		return arrow.PrimitiveTypes.Float64
	default:
		return arrow.BinaryTypes.String
	}
}
