package session

import (
    "context"
    "fmt"
    "os"
    "path/filepath"

    "github.com/aleda145/kavla/cli/internal/python"
    "github.com/aleda145/kavla/cli/internal/runner"
)

func (s *Session) BeginPythonOperation(ctx context.Context, shapeID string) (context.Context, func()) {
    ctx, _, done := s.beginActiveQuery(ctx, runner.QueryRequest{ShapeId: shapeID})
    return ctx, done
}

type PythonRequest struct {
    ShapeID string `json:"shapeId"`
    Name string `json:"name"`
    Code string `json:"code"`
    Inputs map[string]string `json:"inputs"`
}

type PythonResult struct {
    *QueryResult
    python.Response
}

func (s *Session) RunPython(ctx context.Context, executable, root string, request PythonRequest) (*PythonResult, error) {
    directory, err := os.MkdirTemp(root, "python-run-*")
    if err != nil { return nil, err }
    published := false
    defer func() { if !published { _ = os.RemoveAll(directory) } }()
    inputs := map[string]string{}
    for name, id := range request.Inputs {
        if !s.HasQueryResult(id) { return nil, fmt.Errorf("upstream %q is not loaded; run it first", name) }
        path := filepath.Join(directory, fmt.Sprintf("input-%d.parquet", len(inputs)))
        if _, err := s.ExportQueryResult(ctx, id, "parquet", path); err != nil { return nil, fmt.Errorf("export upstream %q: %w", name, err) }
        inputs[name] = path
    }
    outputPath := filepath.Join(directory, "result.parquet")
    response, err := python.Invoke(ctx, executable, directory, map[string]interface{}{
        "mode": "run", "code": request.Code, "inputs": inputs, "output": outputPath,
    })
    if err != nil { return nil, err }
    result := &PythonResult{Response: response}
    if response.Error != "" { return result, nil }
    s.resultMu.Lock()
    defer s.resultMu.Unlock()
    count, columns, err := s.engine.PublishParquetResult(ctx, request.ShapeID, outputPath)
    if err != nil { return nil, fmt.Errorf("publish Python result: %w", err) }
    schema := make([]ResultColumn, len(columns))
    for i, column := range columns { schema[i] = ResultColumn{Name: column.Name, Type: column.Type} }
    s.mu.Lock()
    s.results[request.ShapeID] = QueryResultMetadata{Name: request.Name, RowCount: count}
    previous := s.pythonDirectories[request.ShapeID]
    s.pythonDirectories[request.ShapeID] = []string{directory}
    s.mu.Unlock()
    for _, old := range previous { if err := os.RemoveAll(old); err != nil { s.log("Could not remove previous Python result: %v\n", err) } }
    published = true
    // Readers have completed before publication; only this output remains needed by DuckDB.
    for _, path := range inputs { _ = os.Remove(path) }
    for _, name := range []string{"worker.py", "response.json"} { _ = os.Remove(filepath.Join(directory, name)) }
    result.QueryResult = &QueryResult{RowCount: count, Schema: schema}
    return result, nil
}

func (s *Session) CancelActiveOperations() {
    s.mu.Lock()
    defer s.mu.Unlock()
    for _, query := range s.queries { query.cancel() }
}

func (s *Session) ClearResults(ctx context.Context) error {
    s.mu.Lock()
    ids := make([]string, 0, len(s.results))
    for id := range s.results { ids = append(ids, id) }
    s.mu.Unlock()
    return s.DropResults(ctx, ids)
}
