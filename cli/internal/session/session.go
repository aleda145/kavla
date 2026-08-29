package session

import (
	"context"
	"fmt"
	"strings"
	"sync"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
	"github.com/aleda145/kavla/cli/internal/engine"
	"github.com/aleda145/kavla/cli/internal/runner"
	"github.com/apache/arrow/go/v14/arrow/array"
)

type Client interface {
	SendJSON(msg map[string]interface{}) error
	SendResultData(shapeID string, format runner.ResultFormat, data []byte, rowCount int64, transient bool) error
	ResolveBlobURL(blobID string) (string, error)
}

type Session struct {
	sources            map[string]kavlaconfig.SourceConfig
	allowedDirectories []string
	engine             *engine.Engine
	logf               func(string, ...interface{})
	verbosef           func(string, ...interface{})
	ctx                context.Context
	cancel             context.CancelFunc
	mu                 sync.Mutex
	queries            map[string]activeQuery
	results            map[string]QueryResultMetadata
	nextQueryID        uint64
}

type activeQuery struct {
	cancel func()
	name   string
	id     uint64
}

type SessionTransport struct {
	client   Client
	logf     func(string, ...interface{})
	verbosef func(string, ...interface{})
}

type ResultColumn struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

type QueryResult struct {
	RowCount int64          `json:"rowCount"`
	Schema   []ResultColumn `json:"schema"`
}

type QueryResultMetadata struct {
	Name     string
	RowCount int64
}

func New(sources map[string]kavlaconfig.SourceConfig) *Session {
	return NewWithAllowedDirectories(sources, nil)
}

func NewWithAllowedDirectories(sources map[string]kavlaconfig.SourceConfig, allowedDirectories []string) *Session {
	if sources == nil {
		sources = make(map[string]kavlaconfig.SourceConfig)
	}
	return &Session{
		sources:            sources,
		allowedDirectories: append([]string(nil), allowedDirectories...),
		queries:            make(map[string]activeQuery),
		results:            make(map[string]QueryResultMetadata),
	}
}

func (s *Session) SetLogger(logf func(string, ...interface{})) {
	s.logf = logf
}

func (s *Session) SetVerboseLogger(verbosef func(string, ...interface{})) {
	s.verbosef = verbosef
}

func (s *Session) log(format string, args ...interface{}) {
	if s.logf != nil {
		s.logf(format, args...)
	}
}

func (s *Session) verbose(format string, args ...interface{}) {
	if s.verbosef != nil {
		s.verbosef(format, args...)
	}
}

func (s *Session) Start() error {
	s.ctx, s.cancel = context.WithCancel(context.Background())
	eng, err := engine.NewWithAllowedDirectories(s.sources, s.logf, s.allowedDirectories)
	if err != nil {
		s.cancel()
		s.ctx = nil
		s.cancel = nil
		return err
	}
	s.engine = eng
	return nil
}

func (s *Session) Cancel() {
	if s.cancel != nil {
		s.cancel()
	}
	s.mu.Lock()
	for shapeID, query := range s.queries {
		query.cancel()
		delete(s.queries, shapeID)
	}
	s.mu.Unlock()
}

func (s *Session) Close() error {
	s.Cancel()
	if s.engine == nil {
		return nil
	}
	return s.engine.Close()
}

func (s *Session) SourceList() []map[string]interface{} {
	if s.engine != nil {
		statuses := s.engine.SourceStatuses()
		sourceList := make([]map[string]interface{}, 0, len(statuses))
		for _, status := range statuses {
			entry := map[string]interface{}{
				"name":      status.Name,
				"type":      status.Type,
				"available": status.Available,
			}
			if status.Error != "" {
				entry["error"] = status.Error
			}
			sourceList = append(sourceList, entry)
		}
		return sourceList
	}

	sourceList := make([]map[string]interface{}, 0, len(s.sources))
	for name, src := range s.sources {
		sourceList = append(sourceList, map[string]interface{}{
			"name":      name,
			"type":      src.Type,
			"available": true,
		})
	}
	return sourceList
}

func (s *Session) HandleQuery(client Client, req runner.QueryRequest) {
	err := s.ExecuteQuery(s.ctx, client, req)
	if err == nil || err == context.Canceled {
		return
	}
	_ = client.SendJSON(map[string]interface{}{
		"type":    "query_error",
		"error":   err.Error(),
		"shapeId": req.ShapeId,
	})
}

func (s *Session) ExecuteQuery(parent context.Context, client Client, req runner.QueryRequest) error {
	queryCtx, queryLabel, finish := s.beginActiveQuery(parent, req)
	defer finish()

	s.log("\nQuery from source '%s':\n%s\n", req.SourceName, strings.TrimSpace(req.SQL))

	if err := s.mountRemoteFileSources(queryCtx, client, req.MountedFileSources); err != nil {
		if queryCtx.Err() != nil {
			s.log("Query cancelled for %s\n", queryLabel)
			return context.Canceled
		}
		s.log("Query failed: %v\n", err)
		return err
	}

	result, err := runner.Execute(queryCtx, req, &SessionTransport{
		client:   client,
		logf:     s.logf,
		verbosef: s.verbosef,
	}, s.engine)
	if err != nil {
		if queryCtx.Err() != nil {
			s.log("Query cancelled for %s\n", queryLabel)
			return context.Canceled
		}
		s.log("Query failed: %v\n", err)
		return err
	}

	s.log("%d rows sent, %d bytes to canvas\n", result.RowCount, result.DataSize)
	return nil
}

func (s *Session) beginActiveQuery(parent context.Context, req runner.QueryRequest) (context.Context, string, func()) {
	queryLabel := req.QueryName
	if queryLabel == "" {
		queryLabel = req.ShapeId
	}

	queryCtx, cancel := context.WithCancel(s.ctx)
	stopParentCancellation := context.AfterFunc(parent, cancel)
	s.mu.Lock()
	if existing, ok := s.queries[req.ShapeId]; ok {
		existing.cancel()
	}
	s.nextQueryID++
	queryID := s.nextQueryID
	s.queries[req.ShapeId] = activeQuery{
		cancel: cancel,
		name:   queryLabel,
		id:     queryID,
	}
	s.mu.Unlock()
	finish := func() {
		stopParentCancellation()
		cancel()
		s.mu.Lock()
		if active, ok := s.queries[req.ShapeId]; ok && active.id == queryID {
			delete(s.queries, req.ShapeId)
		}
		s.mu.Unlock()
	}
	return queryCtx, queryLabel, finish
}

func (s *Session) RunQuery(parent context.Context, client Client, req runner.QueryRequest) (*QueryResult, error) {
	queryCtx, queryLabel, finish := s.beginActiveQuery(parent, req)
	defer finish()
	if req.Restore {
		s.log("Rerunning query '%s' to fetch results\n", queryLabel)
	} else {
		s.log("\nQuery from source '%s':\n%s\n", req.SourceName, strings.TrimSpace(req.SQL))
	}

	if err := s.mountRemoteFileSources(queryCtx, client, req.MountedFileSources); err != nil {
		return nil, err
	}
	preparedSQL, err := runner.PreparePreviewSQL(req, s.engine, 0)
	if err != nil {
		return nil, err
	}
	if err := s.engine.CreateResultView(queryCtx, req.ShapeId, preparedSQL); err != nil {
		if queryCtx.Err() != nil {
			s.log("Query cancelled for %s\n", queryLabel)
			return nil, context.Canceled
		}
		return nil, err
	}
	rowCount, err := s.engine.ResultRowCount(queryCtx, req.ShapeId)
	if err != nil {
		return nil, err
	}
	engineSchema, err := s.engine.ResultSchema(queryCtx, req.ShapeId)
	if err != nil {
		return nil, err
	}
	schema := make([]ResultColumn, len(engineSchema))
	for index, field := range engineSchema {
		schema[index] = ResultColumn{Name: field.Name, Type: field.Type}
	}
	s.mu.Lock()
	s.results[req.ShapeId] = QueryResultMetadata{Name: queryLabel, RowCount: rowCount}
	s.mu.Unlock()
	if !req.Restore {
		s.log("Prepared a %d-row query result for browser access\n", rowCount)
	}
	return &QueryResult{RowCount: rowCount, Schema: schema}, nil
}

func (s *Session) QueryResultPage(ctx context.Context, shapeID string, offset, limit int) (array.RecordReader, error) {
	return s.engine.QueryResultPage(ctx, shapeID, offset, limit)
}

func (s *Session) ExportQueryResult(ctx context.Context, shapeID, format, outputPath string) (QueryResultMetadata, error) {
	if strings.TrimSpace(shapeID) == "" {
		return QueryResultMetadata{}, fmt.Errorf("shape id is required")
	}
	if strings.TrimSpace(outputPath) == "" {
		return QueryResultMetadata{}, fmt.Errorf("query result export path is required")
	}
	s.mu.Lock()
	metadata, ok := s.results[shapeID]
	s.mu.Unlock()
	if !ok {
		return QueryResultMetadata{}, fmt.Errorf("query result is not loaded")
	}
	if err := s.engine.ExportResult(ctx, shapeID, format, outputPath); err != nil {
		return QueryResultMetadata{}, err
	}
	return metadata, nil
}

func (s *Session) HasQueryResult(shapeID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.results[shapeID]
	return ok
}

func (s *Session) DropResults(ctx context.Context, shapeIDs []string) error {
	for _, shapeID := range shapeIDs {
		if err := s.engine.DropResult(ctx, shapeID); err != nil {
			return err
		}
		s.mu.Lock()
		delete(s.results, shapeID)
		s.mu.Unlock()
	}
	return nil
}

func (s *Session) mountRemoteFileSources(ctx context.Context, client Client, mountedFileSources []runner.MountedFileSource) error {
	for _, mountedFileSource := range mountedFileSources {
		fileReference := mountedFileSource.BlobID
		if fileReference == "" {
			fileReference = mountedFileSource.R2ObjectKey
		}
		blobURL, err := client.ResolveBlobURL(fileReference)
		if err != nil {
			return fmt.Errorf("failed to resolve canvas file for %q: %w", mountedFileSource.SourceName, err)
		}

		mountSQL, err := s.engine.PrepareRemoteFileMountSQL(mountedFileSource.SourceName, mountedFileSource.FileName, blobURL)
		if err != nil {
			return err
		}
		s.verbose("Prepared remote mount SQL for source %q:\n%s\n", mountedFileSource.SourceName, mountSQL)

		if err := s.engine.MountRemoteFileSource(ctx, mountedFileSource.SourceName, mountedFileSource.FileName, blobURL); err != nil {
			return err
		}
	}

	return nil
}

func (s *Session) CancelQuery(shapeID string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	query, ok := s.queries[shapeID]
	if !ok {
		return "", false
	}

	query.cancel()
	delete(s.queries, shapeID)
	return query.name, true
}

func (s *Session) GetTables(sourceName string) ([]string, error) {
	if strings.TrimSpace(sourceName) == "" {
		return nil, fmt.Errorf("source name is required")
	}
	return s.engine.GetTables(sourceName)
}

func (s *Session) GetSourceSchema(ctx context.Context, tableRef string) ([]map[string]string, error) {
	if strings.TrimSpace(tableRef) == "" {
		return nil, fmt.Errorf("table reference is required")
	}
	return s.engine.DescribeTable(ctx, tableRef)
}

func (s *Session) GetSourceStats(ctx context.Context, tableRef string) (map[string]int64, error) {
	if strings.TrimSpace(tableRef) == "" {
		return nil, fmt.Errorf("table reference is required")
	}
	return s.engine.GetSourceStats(ctx, tableRef)
}

func (s *Session) ExportSourceTable(ctx context.Context, tableRef, format, outputPath string) error {
	if strings.TrimSpace(tableRef) == "" {
		return fmt.Errorf("table reference is required")
	}
	if strings.TrimSpace(outputPath) == "" {
		return fmt.Errorf("source export path is required")
	}
	return s.engine.ExportSourceTable(ctx, tableRef, format, outputPath)
}

func (s *Session) HandleGetTables(client Client, requestID, sourceName string) {
	if strings.TrimSpace(sourceName) == "" {
		_ = client.SendJSON(map[string]interface{}{
			"type":      "error",
			"requestId": requestID,
			"error":     "failed to get tables: source name is required",
			"payload": map[string]string{
				"message": "failed to get tables: source name is required",
				"error":   "failed to get tables: source name is required",
			},
		})
		return
	}

	tables, err := s.GetTables(sourceName)
	if err != nil {
		s.log("Failed to get tables for source '%s': %v\n", sourceName, err)
		message := fmt.Sprintf("failed to get tables: %v", err)
		_ = client.SendJSON(map[string]interface{}{
			"type":      "error",
			"requestId": requestID,
			"error":     message,
			"payload": map[string]string{
				"message": message,
				"error":   message,
			},
		})
		return
	}

	_ = client.SendJSON(map[string]interface{}{
		"type":      "get_source_tables_response",
		"requestId": requestID,
		"payload": map[string]interface{}{
			"tables": tables,
		},
	})
}

func (s *Session) HandleGetSourceSchema(client Client, requestID, tableRef string) {
	columns, err := s.GetSourceSchema(s.ctx, tableRef)
	if err != nil {
		s.log("Failed to get schema for table '%s': %v\n", tableRef, err)
		message := fmt.Sprintf("failed to get schema: %v", err)
		_ = client.SendJSON(map[string]interface{}{
			"type":      "error",
			"requestId": requestID,
			"error":     message,
			"payload": map[string]string{
				"message": message,
				"error":   message,
			},
		})
		return
	}

	_ = client.SendJSON(map[string]interface{}{
		"type":      "get_source_schema_response",
		"requestId": requestID,
		"payload": map[string]interface{}{
			"columns": columns,
		},
	})
}

func (s *Session) HandleGetSourceStats(client Client, requestID, tableRef string) {
	stats, err := s.GetSourceStats(s.ctx, tableRef)
	if err != nil {
		s.log("Failed to get stats for table '%s': %v\n", tableRef, err)
		message := fmt.Sprintf("failed to get source stats: %v", err)
		_ = client.SendJSON(map[string]interface{}{
			"type":      "error",
			"requestId": requestID,
			"error":     message,
			"payload": map[string]string{
				"message": message,
				"error":   message,
			},
		})
		return
	}

	_ = client.SendJSON(map[string]interface{}{
		"type":      "get_source_stats_response",
		"requestId": requestID,
		"payload":   stats,
	})
}

func (t *SessionTransport) SendResultData(shapeID string, format runner.ResultFormat, data []byte, rowCount int64, transient bool) error {
	return t.client.SendResultData(shapeID, format, data, rowCount, transient)
}

func (t *SessionTransport) MaxResultDataBytes() int {
	limiter, ok := t.client.(interface{ MaxResultDataBytes() int })
	if !ok {
		return 0
	}
	return limiter.MaxResultDataBytes()
}

func (t *SessionTransport) SendJSON(msg map[string]interface{}) error {
	return t.client.SendJSON(msg)
}

func (t *SessionTransport) Log(format string, args ...interface{}) {
	if t.logf != nil {
		t.logf(format, args...)
	}
}

func (t *SessionTransport) Verbose(format string, args ...interface{}) {
	if t.verbosef != nil {
		t.verbosef(format, args...)
	}
}
