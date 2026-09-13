package localapp

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "os"
    "strings"
    "github.com/google/uuid"

    "github.com/aleda145/kavla/cli/internal/python"
    "github.com/aleda145/kavla/cli/internal/session"
)

func (s *Server) pythonConfig() (string, python.Config) {
    manifest := s.document.Manifest()
    config := python.DefaultConfig()
    if manifest.Python != nil { config = *manifest.Python }
    return manifest.DocumentID, config
}

func (s *Server) lockPython(ctx context.Context) (func(), error) {
    select {
    case s.pythonGate <- struct{}{}: return func() { <-s.pythonGate }, nil
    case <-ctx.Done(): return nil, ctx.Err()
    }
}

func (s *Server) ensurePython(ctx context.Context, documentID string, config python.Config) (string, error) {
    if executable, ok := s.pythonRuntime.Prepared(documentID, config); ok { return executable, nil }
    executable, resolved, err := s.pythonRuntime.Ensure(ctx, documentID, config)
    if err != nil { return "", err }
    if err := ctx.Err(); err != nil { return "", err }
    if err := s.document.SetPythonConfig(documentID, resolved); err != nil { return "", err }
    return executable, nil
}

func (s *Server) handlePythonEnvironment(w http.ResponseWriter, r *http.Request) {
    documentID, config := s.pythonConfig()
    if r.Method == http.MethodGet {
        _, ready := s.pythonRuntime.Prepared(documentID, config)
        writeJSON(w, http.StatusOK, map[string]interface{}{"config": config, "ready": ready})
        return
    }
    r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
    var update python.Config
    if err := json.NewDecoder(r.Body).Decode(&update); err != nil { writeAPIError(w, 400, err); return }
    // A requirements edit resolves a new lock; clients cannot supply arbitrary lockfile contents.
    update.Lock = ""
    if update.Version == "" { update.Version = config.Version }
    if err := python.ValidateConfig(update); err != nil { writeAPIError(w, 400, err); return }
    queries, done, err := s.beginQueryOperation(); if err != nil { writeAPIError(w, 503, err); return }; defer done()
    ctx, finish := queries.BeginPythonOperation(r.Context(), "python:environment"); defer finish()
    unlock, err := s.lockPython(ctx); if err != nil { writeAPIError(w, 422, err); return }; defer unlock()
    _, resolved, err := s.pythonRuntime.Ensure(ctx, documentID, update)
    if err == nil { err = ctx.Err() }
    if err == nil { err = s.document.SetPythonConfig(documentID, resolved) }
    if err != nil { writeAPIError(w, 422, err); return }
    writeJSON(w, 200, map[string]interface{}{"config": resolved, "ready": true})
}

func (s *Server) handlePythonAnalyze(w http.ResponseWriter, r *http.Request) {
    r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
    var request struct { Code string `json:"code"`; Names []string `json:"names"`; Prepare bool `json:"prepare"` }
    if err := json.NewDecoder(r.Body).Decode(&request); err != nil { writeAPIError(w, 400, err); return }
    queries, done, err := s.beginQueryOperation(); if err != nil { writeAPIError(w, 503, err); return }; defer done()
    ctx, finish := queries.BeginPythonOperation(r.Context(), "python:analysis:"+uuid.NewString()); defer finish()
    documentID, config := s.pythonConfig()
    executable, ready := s.pythonRuntime.Prepared(documentID, config)
    if !ready {
        if !request.Prepare { writeJSON(w, 200, map[string]interface{}{"dependencies": []string{}, "needsSetup": true}); return }
        unlock, err := s.lockPython(ctx); if err != nil { writeAPIError(w, 422, err); return }
        executable, err = s.ensurePython(ctx, documentID, config)
        unlock()
        if err != nil { writeAPIError(w, 422, err); return }
    }
    directory, err := os.MkdirTemp(s.transientDir, "python-analysis-*"); if err != nil { writeAPIError(w, 500, err); return }; defer os.RemoveAll(directory)
    response, err := python.Invoke(ctx, executable, directory, map[string]interface{}{"mode": "analyze", "code": request.Code, "names": request.Names})
    if err != nil { writeAPIError(w, 422, err); return }
    writeJSON(w, 200, response)
}

func (s *Server) handlePythonRun(w http.ResponseWriter, r *http.Request) {
    r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
    var request session.PythonRequest
    if err := json.NewDecoder(r.Body).Decode(&request); err != nil { writeAPIError(w, 400, err); return }
    if strings.TrimSpace(request.ShapeID) == "" || strings.TrimSpace(request.Code) == "" { writeAPIError(w, 400, fmt.Errorf("shapeId and code are required")); return }
    queries, done, err := s.beginQueryOperation(); if err != nil { writeAPIError(w, 503, err); return }; defer done()
    ctx, finish := queries.BeginPythonOperation(r.Context(), request.ShapeID); defer finish()
    unlock, err := s.lockPython(ctx); if err != nil { writeAPIError(w, 422, err); return }; defer unlock()
    documentID, config := s.pythonConfig()
    executable, err := s.ensurePython(ctx, documentID, config); if err != nil { writeAPIError(w, 422, err); return }
    result, err := queries.RunPython(ctx, executable, s.transientDir, request)
    if err != nil { writeAPIError(w, 422, err); return }
    writeJSON(w, 200, result)
}

// Prevent old executions from publishing into a newly opened canvas.
func (s *Server) beginDocumentSwitch() (func(), error) {
    s.workerMu.Lock()
    if s.closing || s.reconfiguring { s.workerMu.Unlock(); return nil, fmt.Errorf("Kavla is busy changing documents or sources") }
    s.reconfiguring = true
    s.workerMu.Unlock()
    s.queriesMu.RLock()
    queries := s.queries
    s.queriesMu.RUnlock()
    if queries != nil { queries.CancelActiveOperations() }
    s.workers.Wait()
    var clearErr error
    if queries != nil { clearErr = queries.ClearResults(context.Background()) }
    if err := clearErr; err != nil {
        s.workerMu.Lock(); s.reconfiguring = false; s.workerMu.Unlock()
        return nil, err
    }
    return func() { s.workerMu.Lock(); s.reconfiguring = false; s.workerMu.Unlock() }, nil
}
