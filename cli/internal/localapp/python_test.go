package localapp

import (
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "path/filepath"
    "os"
    "testing"
    "testing/fstest"

    "github.com/aleda145/kavla/cli/internal/python"
)

func TestPythonDocumentConfigurationRoundTrip(t *testing.T) {
    path := filepath.Join(t.TempDir(), "python.kavla")
    doc, err := OpenDocument(path); if err != nil { t.Fatal(err) }; defer doc.CleanupWorkingCopy()
    if doc.Manifest().Python != nil { t.Fatal("legacy documents should have no Python config") }
    if err := doc.StageCanvas([]byte(`{"records":[{"id":"shape:python","typeName":"shape","type":"python-text-area","props":{"text":"result = query_1"}}]}`)); err != nil { t.Fatal(err) }
    config := python.DefaultConfig(); config.Lock = "version = 1\n"; config.Requirements = append(config.Requirements, "scipy>=1.0")
    if err := doc.SetPythonConfig(doc.Manifest().DocumentID, config); err != nil { t.Fatal(err) }
    if err := doc.Save(); err != nil { t.Fatal(err) }
    reopened, err := OpenDocument(path); if err != nil { t.Fatal(err) }; defer reopened.CleanupWorkingCopy()
    saved := reopened.Manifest().Python
    if saved == nil || saved.Lock != config.Lock || len(saved.Requirements) != 4 { t.Fatalf("Python config lost: %+v", saved) }
    saved.Requirements[0] = "changed"
    if reopened.Manifest().Python.Requirements[0] == "changed" { t.Fatal("manifest copy aliases requirements") }
    if len(reopened.Manifest().Blobs) != 0 { t.Fatal("Python results should not enter the document") }
    if err := reopened.SetPythonConfig("another-document", config); err == nil { t.Fatal("accepted stale document mutation") }
}

func TestPythonDiscoveryDoesNotInstallOrExecute(t *testing.T) {
    document, err := OpenDocument(filepath.Join(t.TempDir(), "python.kavla")); if err != nil { t.Fatal(err) }; defer document.CleanupWorkingCopy()
    server, err := NewServer(document, fstest.MapFS{}, nil, false); if err != nil { t.Fatal(err) }
    defer server.queries.Close()
    defer os.RemoveAll(server.transientDir)
    server.pythonRuntime.Root = t.TempDir()
    recorder := httptest.NewRecorder()
    server.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/session/python", nil))
    if recorder.Code != 200 { t.Fatal(recorder.Body.String()) }
    var response struct { Config python.Config `json:"config"`; Ready bool `json:"ready"` }
    if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil { t.Fatal(err) }
    if response.Ready || response.Config.Version != "3.13" { t.Fatalf("unexpected discovery: %+v", response) }
    if document.Manifest().Python != nil { t.Fatal("discovery mutated the document") }
    denied := httptest.NewRecorder()
    server.routes().ServeHTTP(denied, httptest.NewRequest(http.MethodPost, "/api/session/python/run", nil))
    if denied.Code != http.StatusForbidden { t.Fatal("Python execution accepted a request without same-origin authorization") }
}
