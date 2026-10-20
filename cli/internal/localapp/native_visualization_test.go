package localapp

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aleda145/kavla/cli/internal/session"
	"github.com/apache/arrow/go/v14/arrow/ipc"
)

func TestNativeVisualizationComputeUsesProtectedDocumentSession(t *testing.T) {
	document, err := OpenDocument(filepath.Join(t.TempDir(), "viz.kavla"))
	if err != nil {
		t.Fatal(err)
	}
	defer document.CleanupWorkingCopy()
	queries := session.New(nil)
	if err := queries.Start(); err != nil {
		t.Fatal(err)
	}
	defer queries.Close()
	owner, cancelOwner := context.WithCancel(context.Background())
	defer cancelOwner()
	server := &Server{document: document, queries: queries, ownerContext: owner, ownerToken: "test-editor"}
	server.canvasHandler = server.routes()
	registry := &canvasRegistry{root: server, files: map[string]string{"viz": document.Path()}, runtimes: map[string]*Server{"viz": server}}
	server.canvases = registry
	call := func(token, documentID, origin string, ctx context.Context, sql string) *httptest.ResponseRecorder {
		body, err := json.Marshal(map[string]string{"sql": sql})
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(http.MethodPost, "/viz/api/session/compute", bytes.NewReader(body)).WithContext(ctx)
		r.Header.Set("Origin", origin)
		r.Header.Set("X-Kavla-Editor", token)
		r.Header.Set("X-Kavla-Document-ID", documentID)
		w := httptest.NewRecorder()
		registry.ServeHTTP(w, r)
		return w
	}
	ctx := context.Background()
	id := document.Manifest().DocumentID
	if w := call("wrong-editor", id, "http://example.com", ctx, "SELECT 1"); w.Code != 409 {
		t.Fatalf("ownership guard: %d", w.Code)
	}
	if w := call("test-editor", "old-document", "http://example.com", ctx, "SELECT 1"); w.Code != 409 {
		t.Fatalf("document guard: %d", w.Code)
	}
	if w := call("test-editor", id, "http://another-origin.example", ctx, "SELECT 1"); w.Code != 403 {
		t.Fatalf("origin guard: %d", w.Code)
	}
	w := call("test-editor", id, "http://example.com", ctx, "SELECT i%10 AS bin, count(*) AS n FROM range(1000000) t(i) GROUP BY bin")
	if w.Code != 200 || w.Header().Get("Content-Type") != "application/vnd.apache.arrow.stream" {
		t.Fatalf("Arrow response: %d %s", w.Code, w.Body.String())
	}
	reader, err := ipc.NewReader(bytes.NewReader(w.Body.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Release()
	var count int64
	for reader.Next() {
		count += reader.Record().NumRows()
	}
	if reader.Err() != nil || count != 10 {
		t.Fatalf("unexpected Arrow rows: %d (%v)", count, reader.Err())
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if w := call("test-editor", id, "http://example.com", canceled, "SELECT * FROM range(1000000)"); w.Code != 422 || !strings.Contains(w.Body.String(), "canceled") {
		t.Fatalf("request cancellation: %d %s", w.Code, w.Body.String())
	}
	if w := call("test-editor", id, "http://example.com", ctx, "CREATE TABLE forbidden(x INTEGER)"); w.Code != 422 {
		t.Fatalf("compute must reject DDL: %d", w.Code)
	}
}
