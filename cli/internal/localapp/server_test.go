package localapp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
	"github.com/apache/arrow/go/v14/arrow/ipc"
)

type sseRecorder struct {
	header  http.Header
	body    bytes.Buffer
	flushed chan struct{}
	mu      sync.Mutex
}

func newSSERecorder() *sseRecorder {
	return &sseRecorder{header: make(http.Header), flushed: make(chan struct{}, 1)}
}

func (r *sseRecorder) Header() http.Header { return r.header }
func (r *sseRecorder) WriteHeader(_ int)   {}
func (r *sseRecorder) Write(data []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.body.Write(data)
}
func (r *sseRecorder) Flush() {
	select {
	case r.flushed <- struct{}{}:
	default:
	}
}
func (r *sseRecorder) String() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.body.String()
}

func TestStartFallsBackWhenRequestedPortIsBusy(t *testing.T) {
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	occupiedPort := occupied.Addr().(*net.TCPAddr).Port

	server := &Server{assets: fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("ok")}}}
	launchURL, err := server.Start("127.0.0.1", occupiedPort, true)
	if err != nil {
		t.Fatal(err)
	}
	defer server.http.Close()

	_, launchPort, err := net.SplitHostPort(strings.TrimSuffix(strings.TrimPrefix(launchURL, "http://"), "/"))
	if err != nil {
		t.Fatal(err)
	}
	if launchPort == fmt.Sprintf("%d", occupiedPort) {
		t.Fatalf("expected a fallback port, got occupied port %d", occupiedPort)
	}
}

func TestCLIEventsStartsWithRuntimeSnapshot(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	document, err := OpenDocument(filepath.Join(t.TempDir(), "runtime-events.kavla"))
	if err != nil {
		t.Fatal(err)
	}
	server, err := NewServer(document, fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("ok")}}, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close(context.Background()) })

	requestContext, cancel := context.WithCancel(context.Background())
	request := httptest.NewRequest(http.MethodGet, "/api/cli/events", nil).WithContext(requestContext)
	recorder := newSSERecorder()
	done := make(chan struct{})
	go func() {
		server.routes().ServeHTTP(recorder, request)
		close(done)
	}()

	select {
	case <-recorder.flushed:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for SSE snapshot")
	}
	cancel()
	<-done

	if recorder.Header().Get("Content-Type") != "text/event-stream" {
		t.Fatalf("expected SSE content type, got %q", recorder.Header().Get("Content-Type"))
	}
	if body := recorder.String(); !strings.Contains(body, "event: snapshot") || !strings.Contains(body, `"sources"`) {
		t.Fatalf("expected runtime snapshot event, got %q", body)
	}
}

func TestExportCLISourceTableWithoutQuery(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	sourceDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(sourceDir, "people.csv"), []byte("name,age\nAda,36\nGrace,40\n"), 0600); err != nil {
		t.Fatal(err)
	}
	document, err := OpenDocument(filepath.Join(t.TempDir(), "source-export.kavla"))
	if err != nil {
		t.Fatal(err)
	}
	server, err := NewServer(document, fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("ok")}}, map[string]kavlaconfig.SourceConfig{
		"files": {Type: "directory", Connection: sourceDir},
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close(context.Background()) })

	handler := server.routes()
	body := bytes.NewBufferString(`{"tableRef":"files.people","format":"csv","fileName":"people"}`)
	request := httptest.NewRequest(http.MethodPost, "/api/cli/source-export", body)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "http://example.com")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("expected source export to be prepared, got %d: %s", response.Code, response.Body.String())
	}
	var prepared struct {
		DownloadURL string `json:"downloadUrl"`
		FileName    string `json:"fileName"`
	}
	if err := json.NewDecoder(response.Body).Decode(&prepared); err != nil {
		t.Fatal(err)
	}
	if prepared.FileName != "people.csv" {
		t.Fatalf("expected people.csv, got %q", prepared.FileName)
	}

	downloadRequest := httptest.NewRequest(http.MethodGet, prepared.DownloadURL, nil)
	downloadResponse := httptest.NewRecorder()
	handler.ServeHTTP(downloadResponse, downloadRequest)
	if downloadResponse.Code != http.StatusOK {
		t.Fatalf("expected source download, got %d: %s", downloadResponse.Code, downloadResponse.Body.String())
	}
	if body := downloadResponse.Body.String(); body != "name,age\nAda,36\nGrace,40\n" {
		t.Fatalf("unexpected exported CSV: %q", body)
	}

	parquetBody := bytes.NewBufferString(`{"tableRef":"files.people","format":"parquet","fileName":"people"}`)
	parquetRequest := httptest.NewRequest(http.MethodPost, "/api/cli/source-export", parquetBody)
	parquetRequest.Header.Set("Content-Type", "application/json")
	parquetRequest.Header.Set("Origin", "http://example.com")
	parquetResponse := httptest.NewRecorder()
	handler.ServeHTTP(parquetResponse, parquetRequest)
	if parquetResponse.Code != http.StatusCreated {
		t.Fatalf("expected Parquet source export to be prepared, got %d: %s", parquetResponse.Code, parquetResponse.Body.String())
	}
	if err := json.NewDecoder(parquetResponse.Body).Decode(&prepared); err != nil {
		t.Fatal(err)
	}
	parquetDownloadRequest := httptest.NewRequest(http.MethodGet, prepared.DownloadURL, nil)
	parquetDownloadResponse := httptest.NewRecorder()
	handler.ServeHTTP(parquetDownloadResponse, parquetDownloadRequest)
	parquetData := parquetDownloadResponse.Body.Bytes()
	if parquetDownloadResponse.Code != http.StatusOK || len(parquetData) < 8 || string(parquetData[:4]) != "PAR1" || string(parquetData[len(parquetData)-4:]) != "PAR1" {
		t.Fatalf("expected a valid Parquet download, got status %d and %d bytes", parquetDownloadResponse.Code, len(parquetData))
	}
}

func TestLocalQueryKeepsTheFullResultOnlyAtRuntime(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	document, err := OpenDocument(filepath.Join(t.TempDir(), "query.kavla"))
	if err != nil {
		t.Fatal(err)
	}
	server, err := NewServer(document, fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("ok")}}, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close(context.Background()) })

	body := bytes.NewBufferString(`{"sql":"SELECT range AS value FROM range(10005)","shapeId":"shape:http"}`)
	request := httptest.NewRequest(http.MethodPost, "/api/session/queries", body)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "http://example.com")
	response := httptest.NewRecorder()
	server.routes().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("expected successful query, got %d: %s", response.Code, response.Body.String())
	}

	var result localQueryResponse
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatalf("decode query response: %v", err)
	}
	if result.RowCount != 10005 {
		t.Fatalf("expected the complete result row count, got %d", result.RowCount)
	}
	if len(result.Schema) != 1 || result.Schema[0].Name != "value" {
		t.Fatalf("expected result schema metadata, got %+v", result.Schema)
	}

	if got := len(document.Manifest().Blobs); got != 0 {
		t.Fatalf("query execution must not add blobs to the .kavla document, got %d", got)
	}

	pageRequest := httptest.NewRequest(http.MethodGet, "/api/session/queries/shape:http/rows?offset=9995&limit=10", nil)
	pageResponse := httptest.NewRecorder()
	server.routes().ServeHTTP(pageResponse, pageRequest)
	if pageResponse.Code != http.StatusOK {
		t.Fatalf("expected Arrow page, got %d: %s", pageResponse.Code, pageResponse.Body.String())
	}
	reader, err := ipc.NewReader(bytes.NewReader(pageResponse.Body.Bytes()))
	if err != nil {
		t.Fatalf("open Arrow page: %v", err)
	}
	defer reader.Release()
	var pageRows int64
	for reader.Next() {
		pageRows += reader.Record().NumRows()
	}
	if pageRows != 10 {
		t.Fatalf("expected paging to reach the complete live result, got %d rows", pageRows)
	}

	exportBody := bytes.NewBufferString(`{"format":"csv","fileName":"all-values"}`)
	exportRequest := httptest.NewRequest(http.MethodPost, "/api/session/queries/shape:http/export", exportBody)
	exportRequest.Header.Set("Content-Type", "application/json")
	exportRequest.Header.Set("Origin", "http://example.com")
	exportResponse := httptest.NewRecorder()
	server.routes().ServeHTTP(exportResponse, exportRequest)
	if exportResponse.Code != http.StatusCreated {
		t.Fatalf("expected live query view export, got %d: %s", exportResponse.Code, exportResponse.Body.String())
	}
	var preparedExport struct {
		DownloadURL string `json:"downloadUrl"`
		FileName    string `json:"fileName"`
	}
	if err := json.NewDecoder(exportResponse.Body).Decode(&preparedExport); err != nil {
		t.Fatal(err)
	}
	if preparedExport.FileName != "all-values.csv" {
		t.Fatalf("expected all-values.csv, got %q", preparedExport.FileName)
	}
	exportDownloadRequest := httptest.NewRequest(http.MethodGet, preparedExport.DownloadURL, nil)
	exportDownloadResponse := httptest.NewRecorder()
	server.routes().ServeHTTP(exportDownloadResponse, exportDownloadRequest)
	if exportDownloadResponse.Code != http.StatusOK {
		t.Fatalf("expected query export download, got %d: %s", exportDownloadResponse.Code, exportDownloadResponse.Body.String())
	}
	if exportedCSV := exportDownloadResponse.Body.String(); !strings.HasPrefix(exportedCSV, "value\n0\n1\n") {
		t.Fatalf("unexpected query export prefix: %q", exportedCSV[:min(len(exportedCSV), 40)])
	}

	dropRequest := httptest.NewRequest(http.MethodDelete, "/api/session/queries/shape:http/result", nil)
	dropRequest.Header.Set("Origin", "http://example.com")
	dropResponse := httptest.NewRecorder()
	server.routes().ServeHTTP(dropResponse, dropRequest)
	if dropResponse.Code != http.StatusNoContent {
		t.Fatalf("expected query view to be dropped, got %d: %s", dropResponse.Code, dropResponse.Body.String())
	}

	missingPageRequest := httptest.NewRequest(http.MethodGet, "/api/session/queries/shape:http/rows?offset=0&limit=10", nil)
	missingPageResponse := httptest.NewRecorder()
	server.routes().ServeHTTP(missingPageResponse, missingPageRequest)
	if missingPageResponse.Code != http.StatusNotFound {
		t.Fatalf("expected a dropped result to require a rerun, got %d: %s", missingPageResponse.Code, missingPageResponse.Body.String())
	}
}

func TestBlobEndpointsRequireSameHostOriginForMutations(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	document, err := OpenDocument(filepath.Join(t.TempDir(), "assets.kavla"))
	if err != nil {
		t.Fatal(err)
	}
	server := &Server{
		document: document,
		assets: fstest.MapFS{
			"index.html": &fstest.MapFile{Data: []byte("ok")},
		},
		baseURL: "http://127.0.0.1:1234",
	}
	handler := server.routes()

	sessionRequest := httptest.NewRequest(http.MethodGet, "/api/session", nil)
	sessionResponse := httptest.NewRecorder()
	handler.ServeHTTP(sessionResponse, sessionRequest)
	if sessionResponse.Code != http.StatusOK {
		t.Fatalf("expected session response, got %d", sessionResponse.Code)
	}
	contentSecurityPolicy := sessionResponse.Header().Get("Content-Security-Policy")
	if contentSecurityPolicy == "" {
		t.Fatal("expected a Content Security Policy on responses")
	}
	if !strings.Contains(contentSecurityPolicy, "connect-src 'self'") {
		t.Fatalf("expected CSP to allow same-origin connections, got %q", contentSecurityPolicy)
	}
	if strings.Contains(contentSecurityPolicy, "extensions.duckdb.org") {
		t.Fatalf("expected CSP to block external DuckDB extension repositories, got %q", contentSecurityPolicy)
	}
	var sessionDescription struct {
		DocumentID   string           `json:"documentId"`
		DocumentName string           `json:"documentName"`
		Blobs        []BlobDescriptor `json:"blobs"`
	}
	if err := json.NewDecoder(sessionResponse.Body).Decode(&sessionDescription); err != nil {
		t.Fatalf("decode session response: %v", err)
	}
	if sessionDescription.DocumentID == "" || sessionDescription.DocumentName == "" {
		t.Fatalf("session response is missing document identity")
	}
	if sessionDescription.Blobs == nil {
		t.Fatal("new document session must encode blobs as an empty array, not null")
	}

	removedWebSocketRequest := httptest.NewRequest(http.MethodGet, "/api/session/ws", nil)
	removedWebSocketResponse := httptest.NewRecorder()
	handler.ServeHTTP(removedWebSocketResponse, removedWebSocketRequest)
	if removedWebSocketResponse.Code != http.StatusNotFound {
		t.Fatalf("expected removed WebSocket endpoint to return 404, got %d", removedWebSocketResponse.Code)
	}

	invalidOrigin := httptest.NewRequest(http.MethodPut, "/api/session/blobs/asset:asset:one?kind=asset&shapeId=asset:one&fileName=image.png&mimeType=image/png", bytes.NewReader([]byte("image")))
	invalidOrigin.Header.Set("Origin", "http://attacker.example")
	invalidOriginResponse := httptest.NewRecorder()
	handler.ServeHTTP(invalidOriginResponse, invalidOrigin)
	if invalidOriginResponse.Code != http.StatusForbidden {
		t.Fatalf("expected invalid origin to be forbidden, got %d", invalidOriginResponse.Code)
	}

	put := httptest.NewRequest(http.MethodPut, "/api/session/blobs/asset:asset:one?kind=asset&shapeId=asset:one&fileName=image.png&mimeType=image/png", bytes.NewReader([]byte("image")))
	put.Header.Set("Origin", "http://example.com")
	putResponse := httptest.NewRecorder()
	handler.ServeHTTP(putResponse, put)
	if putResponse.Code != http.StatusCreated {
		t.Fatalf("expected asset creation, got %d: %s", putResponse.Code, putResponse.Body.String())
	}
	var stagedBlob BlobDescriptor
	if err := json.NewDecoder(putResponse.Body).Decode(&stagedBlob); err != nil {
		t.Fatal(err)
	}

	get := httptest.NewRequest(http.MethodGet, "/api/session/blobs/asset:asset:one", nil)
	getResponse := httptest.NewRecorder()
	handler.ServeHTTP(getResponse, get)
	data, err := io.ReadAll(getResponse.Result().Body)
	if err != nil {
		t.Fatal(err)
	}
	if getResponse.Code != http.StatusOK || string(data) != "image" {
		t.Fatalf("unexpected asset response: status=%d body=%q", getResponse.Code, string(data))
	}
	if cacheControl := getResponse.Header().Get("Cache-Control"); cacheControl != "private, max-age=0, must-revalidate" {
		t.Fatalf("expected unversioned asset to revalidate, got %q", cacheControl)
	}

	versionedGet := httptest.NewRequest(http.MethodGet, "/api/session/blobs/asset:asset:one?v="+stagedBlob.SHA256, nil)
	versionedGetResponse := httptest.NewRecorder()
	handler.ServeHTTP(versionedGetResponse, versionedGet)
	if versionedGetResponse.Code != http.StatusOK {
		t.Fatalf("expected versioned asset response, got %d", versionedGetResponse.Code)
	}
	if cacheControl := versionedGetResponse.Header().Get("Cache-Control"); cacheControl != "private, max-age=31536000, immutable" {
		t.Fatalf("expected versioned asset to be immutable, got %q", cacheControl)
	}

	staleVersionGet := httptest.NewRequest(http.MethodGet, "/api/session/blobs/asset:asset:one?v="+strings.Repeat("0", 64), nil)
	staleVersionGetResponse := httptest.NewRecorder()
	handler.ServeHTTP(staleVersionGetResponse, staleVersionGet)
	if staleVersionGetResponse.Code != http.StatusNotFound {
		t.Fatalf("expected stale asset version to return 404, got %d", staleVersionGetResponse.Code)
	}

	deleteRequest := httptest.NewRequest(http.MethodDelete, "/api/session/blobs/asset:asset:one", nil)
	deleteRequest.Header.Set("Origin", "http://example.com")
	deleteResponse := httptest.NewRecorder()
	handler.ServeHTTP(deleteResponse, deleteRequest)
	if deleteResponse.Code != http.StatusNoContent {
		t.Fatalf("expected asset deletion, got %d", deleteResponse.Code)
	}
}

func TestStaticCachePolicy(t *testing.T) {
	server := &Server{assets: fstest.MapFS{
		"index.html":          &fstest.MapFile{Data: []byte("index")},
		"assets/index-abc.js": &fstest.MapFile{Data: []byte("script")},
		"kavla.svg":           &fstest.MapFile{Data: []byte("icon")},
	}}
	handler := server.routes()

	indexResponse := httptest.NewRecorder()
	handler.ServeHTTP(indexResponse, httptest.NewRequest(http.MethodGet, "/", nil))
	if cacheControl := indexResponse.Header().Get("Cache-Control"); cacheControl != "no-store" {
		t.Fatalf("expected index to use no-store, got %q", cacheControl)
	}

	assetResponse := httptest.NewRecorder()
	handler.ServeHTTP(assetResponse, httptest.NewRequest(http.MethodGet, "/assets/index-abc.js", nil))
	if cacheControl := assetResponse.Header().Get("Cache-Control"); cacheControl != "public, max-age=31536000, immutable" {
		t.Fatalf("expected fingerprinted asset to be immutable, got %q", cacheControl)
	}

	iconResponse := httptest.NewRecorder()
	handler.ServeHTTP(iconResponse, httptest.NewRequest(http.MethodGet, "/kavla.svg", nil))
	if cacheControl := iconResponse.Header().Get("Cache-Control"); cacheControl != "public, max-age=3600" {
		t.Fatalf("expected non-fingerprinted static asset to use a short cache, got %q", cacheControl)
	}
}

func TestSessionReportsSavedDocumentFileSize(t *testing.T) {
	documentPath := filepath.Join(t.TempDir(), "size.kavla")
	document, err := OpenDocument(documentPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = document.CleanupWorkingCopy() })
	if err := document.StageCanvas([]byte(`{"records":[]}`)); err != nil {
		t.Fatal(err)
	}
	if err := document.Save(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(documentPath)
	if err != nil {
		t.Fatal(err)
	}
	server := &Server{
		document: document,
		assets:   fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("ok")}},
	}
	request := httptest.NewRequest(http.MethodGet, "/api/session", nil)
	response := httptest.NewRecorder()
	server.routes().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("expected session response, got %d: %s", response.Code, response.Body.String())
	}
	var sessionDescription struct {
		FileSize int64 `json:"fileSize"`
	}
	if err := json.NewDecoder(response.Body).Decode(&sessionDescription); err != nil {
		t.Fatal(err)
	}
	if sessionDescription.FileSize != info.Size() {
		t.Fatalf("expected file size %d, got %d", info.Size(), sessionDescription.FileSize)
	}
}

func TestNewDocumentRequiresConfirmationToOverwriteExistingFile(t *testing.T) {
	directory := t.TempDir()
	document, err := OpenDocument(filepath.Join(directory, "current.kavla"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = document.CleanupWorkingCopy() })

	existingPath := filepath.Join(directory, "new_canvas.kavla")
	existingContents := []byte("existing Kavla document")
	if err := os.WriteFile(existingPath, existingContents, 0600); err != nil {
		t.Fatal(err)
	}

	server := &Server{
		document: document,
		assets:   fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("ok")}},
	}
	body := bytes.NewBufferString(fmt.Sprintf(
		`{"directory":%q,"fileName":"new_canvas.kavla","overwrite":false,"canvasJson":"{\"records\":[]}"}`,
		directory,
	))
	request := httptest.NewRequest(http.MethodPost, "/api/session/new", body)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "http://example.com")
	response := httptest.NewRecorder()
	server.routes().ServeHTTP(response, request)

	if response.Code != http.StatusConflict {
		t.Fatalf("expected existing document conflict, got %d: %s", response.Code, response.Body.String())
	}
	contents, err := os.ReadFile(existingPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(contents, existingContents) {
		t.Fatalf("existing Kavla document was overwritten: %q", contents)
	}
	if document.Path() != filepath.Join(directory, "current.kavla") {
		t.Fatalf("active document changed after conflict: %q", document.Path())
	}

	overwriteBody := bytes.NewBufferString(fmt.Sprintf(
		`{"directory":%q,"fileName":"new_canvas.kavla","overwrite":true,"canvasJson":"{\"records\":[]}"}`,
		directory,
	))
	overwriteRequest := httptest.NewRequest(http.MethodPost, "/api/session/new", overwriteBody)
	overwriteRequest.Header.Set("Content-Type", "application/json")
	overwriteRequest.Header.Set("Origin", "http://example.com")
	overwriteResponse := httptest.NewRecorder()
	server.routes().ServeHTTP(overwriteResponse, overwriteRequest)

	if overwriteResponse.Code != http.StatusOK {
		t.Fatalf("expected confirmed overwrite to succeed, got %d: %s", overwriteResponse.Code, overwriteResponse.Body.String())
	}
	if document.Path() != existingPath || document.Manifest().DocumentName != "new_canvas" {
		t.Fatal("confirmed overwrite did not activate the new document")
	}
	if contents, err := os.ReadFile(existingPath); err != nil {
		t.Fatal(err)
	} else if bytes.Equal(contents, existingContents) {
		t.Fatal("confirmed overwrite did not replace the existing Kavla document")
	}
}

func TestTransientQueryResultIsServedOnceWithoutEnteringDocument(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	document, err := OpenDocument(filepath.Join(t.TempDir(), "transient.kavla"))
	if err != nil {
		t.Fatal(err)
	}
	server := &Server{
		document:         document,
		assets:           fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("ok")}},
		baseURL:          "http://127.0.0.1:1234",
		transientDir:     t.TempDir(),
		transientResults: make(map[string]transientResult),
	}
	resultID, err := server.stageTransientResult("arrow", []byte("arrow-result"))
	if err != nil {
		t.Fatal(err)
	}
	resultPath := server.transientResults[resultID].path
	if len(document.Manifest().Blobs) != 0 {
		t.Fatal("transient query result entered the document manifest")
	}

	handler := server.routes()
	request := httptest.NewRequest(http.MethodGet, "/api/session/query-results/"+resultID, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.String() != "arrow-result" {
		t.Fatalf("unexpected transient result response: status=%d body=%q", response.Code, response.Body.String())
	}
	if _, err := os.Stat(resultPath); !os.IsNotExist(err) {
		t.Fatalf("expected consumed transient result to be deleted, got %v", err)
	}

	secondRequest := httptest.NewRequest(http.MethodGet, "/api/session/query-results/"+resultID, nil)
	secondResponse := httptest.NewRecorder()
	handler.ServeHTTP(secondResponse, secondRequest)
	if secondResponse.Code != http.StatusNotFound {
		t.Fatalf("expected transient result to be one-use, got %d", secondResponse.Code)
	}
}
