package localapp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/aleda145/kavla/cli/internal/engine"
	"github.com/aleda145/kavla/cli/internal/session"
	"github.com/google/uuid"
)

var uploadNameCharacters = regexp.MustCompile(`[^a-zA-Z0-9_]+`)
var uploadTableName = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)

func uploadBaseName(filename string) string {
	name := strings.ToLower(uploadNameCharacters.ReplaceAllString(strings.TrimSuffix(filepath.Base(filename), filepath.Ext(filename)), "_"))
	name = strings.Trim(name, "_")
	if name == "" {
		name = "file"
	}
	if name[0] >= '0' && name[0] <= '9' {
		name = "file_" + name
	}
	return name
}

func uniqueUploadName(base string, blobs []BlobDescriptor) string {
	used := make(map[string]bool)
	for _, blob := range blobs {
		if blob.TableName != "" {
			used[strings.ToLower(blob.TableName)] = true
		}
	}
	name := base
	for suffix := 2; used[strings.ToLower(name)]; suffix++ {
		name = fmt.Sprintf("%s_%d", base, suffix)
	}
	return name
}

// TableName makes a source blob document-owned rather than shape-owned.
// Version-one documents are upgraded in the working copy, never in place.
func (d *Document) prepareUploads() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.canvasJSON) == 0 {
		return nil
	}
	var canvas struct {
		Records []json.RawMessage `json:"records"`
	}
	if err := json.Unmarshal(d.canvasJSON, &canvas); err != nil {
		return err
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(d.canvasJSON, &envelope); err != nil {
		return err
	}
	changed := false
	for i, raw := range canvas.Records {
		var record map[string]interface{}
		if err := json.Unmarshal(raw, &record); err != nil {
			return err
		}
		if record["type"] != "data-source" {
			continue
		}
		id, _ := record["id"].(string)
		props, _ := record["props"].(map[string]interface{})
		if props == nil {
			continue
		}
		if source, _ := props["sourceName"].(string); source != "" {
			continue
		}
		for blobID, blob := range d.blobs {
			if blob.Kind != BlobKindSource || blob.ShapeID != id {
				continue
			}
			if blob.TableName == "" {
				blob.TableName = uniqueUploadName(uploadBaseName(blob.FileName), d.manifest.Blobs)
				d.blobs[blobID] = blob
				d.rebuildBlobListLocked()
			}
			props["sourceName"] = engine.UploadedFilesSource
			props["sourceType"] = "duckdb"
			props["remoteTableRef"] = "uploaded_files.main." + blob.TableName
			encoded, err := json.Marshal(record)
			if err != nil {
				return err
			}
			canvas.Records[i] = encoded
			changed = true
			break
		}
	}
	if changed {
		records, err := json.Marshal(canvas.Records)
		if err != nil {
			return err
		}
		envelope["records"] = records
		encoded, err := json.Marshal(envelope)
		if err != nil {
			return err
		}
		d.canvasJSON = encoded
	}
	d.manifest.FormatVersion = FormatVersion
	return nil
}

func (s *Server) restoreUploads(ctx context.Context, target *session.Session) error {
	return restoreDocumentUploads(ctx, s.document, target)
}

func restoreDocumentUploads(ctx context.Context, document *Document, target *session.Session) error {
	target.EnableUploadedFiles()
	if err := document.prepareUploads(); err != nil {
		return err
	}
	for _, blob := range document.Manifest().Blobs {
		if blob.TableName == "" {
			continue
		}
		path, _, err := document.BlobPath(blob.ID)
		if err != nil {
			return err
		}
		if err := target.ImportUploadedFile(ctx, blob.TableName, blob.FileName, path); err != nil {
			return fmt.Errorf("restore uploaded file %q: %w", blob.FileName, err)
		}
	}
	return nil
}

// Build the replacement session before publishing a new document. An invalid
// uploaded file leaves the current canvas and its query session usable.
func (s *Server) switchDocument(ctx context.Context, document *Document) error {
	previous := s.queries
	var next *session.Session
	if previous != nil {
		next = session.NewWithAllowedDirectories(previous.Sources(), []string{s.transientDir, document.workingDir})
		next.SetLogger(s.logCLIOutput)
		if s.verbose {
			next.SetVerboseLogger(s.logCLIOutput)
		}
		if err := next.Start(); err != nil {
			return err
		}
		if err := restoreDocumentUploads(ctx, document, next); err != nil {
			_ = next.Close()
			return err
		}
	}
	s.document.mu.Lock()
	oldWorkingDir := s.document.workingDir
	s.document.path = document.path
	s.document.workingDir = document.workingDir
	s.document.manifest = document.manifest
	s.document.canvasJSON = document.canvasJSON
	s.document.blobs = document.blobs
	document.workingDir = ""
	s.document.mu.Unlock()
	if next != nil {
		s.queriesMu.Lock()
		s.queries = next
		s.queriesMu.Unlock()
		if err := previous.Close(); err != nil {
			s.logCLIOutput("Close previous query session: %v\n", err)
		}
		s.broadcastCLISources()
	}
	if oldWorkingDir != "" {
		if err := os.RemoveAll(oldWorkingDir); err != nil {
			s.logCLIOutput("Clean up previous document: %v\n", err)
		}
	}
	s.transientMu.Lock()
	for id, result := range s.transientResults {
		if err := os.Remove(result.path); err != nil && !os.IsNotExist(err) {
			s.logCLIOutput("Clean up previous export: %v\n", err)
		}
		delete(s.transientResults, id)
	}
	s.transientMu.Unlock()
	return nil
}

func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	filename := filepath.Base(r.URL.Query().Get("fileName"))
	switch strings.ToLower(filepath.Ext(filename)) {
	case ".csv", ".parquet", ".json", ".ndjson":
	default:
		writeAPIError(w, 400, fmt.Errorf("upload a CSV, Parquet, JSON, or NDJSON file"))
		return
	}
	querySession, done, err := s.beginQueryOperation()
	if err != nil {
		writeAPIError(w, 503, err)
		return
	}
	defer done()
	ctx, cancel := querySession.OperationContext(r.Context())
	defer cancel()
	stop := context.AfterFunc(ctx, func() { _ = r.Body.Close() })
	defer stop()
	id := "upload:" + uuid.NewString()
	name := uniqueUploadName(uploadBaseName(filename), s.document.Manifest().Blobs)
	// The request gate excludes saves until both the native table and blob exist.
	blob, err := s.document.PutBlob(id, BlobDescriptor{Kind: BlobKindSource, FileName: filename, MIMEType: r.Header.Get("Content-Type"), TableName: name}, r.Body)
	if err != nil {
		writeAPIError(w, 400, err)
		return
	}
	complete := false
	defer func() {
		if !complete {
			if err := s.queries.DropUploadedFile(context.Background(), name); err != nil {
				s.logCLIOutput("Clean up failed upload: %v\n", err)
			}
			if err := s.document.DeleteBlob(id); err != nil {
				s.logCLIOutput("Clean up failed upload blob: %v\n", err)
			}
		}
	}()
	path, _, err := s.document.BlobPath(id)
	if err != nil {
		writeAPIError(w, 500, err)
		return
	}
	if err := querySession.ImportUploadedFile(ctx, name, filename, path); err != nil {
		writeAPIError(w, 422, err)
		return
	}
	tableRef := "uploaded_files.main." + name
	schema, err := s.queries.GetSourceSchema(r.Context(), tableRef)
	if err != nil {
		writeAPIError(w, 500, err)
		return
	}
	stats, err := s.queries.GetSourceStats(r.Context(), tableRef)
	if err != nil {
		writeAPIError(w, 500, err)
		return
	}
	complete = true
	s.broadcastCLISources()
	writeJSON(w, 201, map[string]interface{}{"id": id, "tableName": name, "tableRef": tableRef, "blob": blob, "schema": schema, "rowCount": stats["rowCount"]})
}

func (s *Server) handleDeleteUpload(w http.ResponseWriter, r *http.Request) {
	_, blob, err := s.document.BlobPath(r.PathValue("id"))
	if err != nil || blob.TableName == "" {
		writeAPIError(w, 404, fmt.Errorf("uploaded table does not exist"))
		return
	}
	if err := s.queries.DropUploadedFile(r.Context(), blob.TableName); err != nil {
		writeAPIError(w, 422, err)
		return
	}
	if err := s.document.DeleteBlob(blob.ID); err != nil {
		path, _, pathErr := s.document.BlobPath(blob.ID)
		if pathErr == nil {
			pathErr = s.queries.ImportUploadedFile(context.Background(), blob.TableName, blob.FileName, path)
		}
		writeAPIError(w, 500, fmt.Errorf("delete upload: %w (restore: %v)", err, pathErr))
		return
	}
	s.broadcastCLISources()
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleCompute(w http.ResponseWriter, r *http.Request) {
	var request struct {
		SQL       string                `json:"sql"`
		TableName string                `json:"tableName"`
		Columns   []engine.WidgetColumn `json:"columns"`
		Rows      [][]interface{}       `json:"rows"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeAPIError(w, 400, err)
		return
	}
	if strings.TrimSpace(request.SQL) == "" {
		writeAPIError(w, 400, fmt.Errorf("SQL is required"))
		return
	}
	querySession, done, err := s.beginQueryOperation()
	if err != nil {
		writeAPIError(w, 503, err)
		return
	}
	defer done()
	if r.URL.Path == "/api/session/validate" {
		if err := querySession.ValidateQuery(r.Context(), request.SQL); err != nil {
			writeAPIError(w, 422, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.URL.Path == "/api/session/widget-query" {
		reader, err := querySession.QueryWidget(r.Context(), request.SQL, request.TableName, request.Columns, request.Rows)
		if err != nil {
			writeAPIError(w, 422, err)
			return
		}
		defer reader.Release()
		writeArrowResult(w, reader)
		return
	}
	reader, err := querySession.Compute(r.Context(), request.SQL)
	if err != nil {
		writeAPIError(w, 422, err)
		return
	}
	defer reader.Release()
	writeArrowResult(w, reader)
}

// Streaming event connections must not hold the document gate indefinitely.
func (s *Server) documentRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") || strings.HasSuffix(r.URL.Path, "/events") || (r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/api/session/queries/") && !strings.HasSuffix(r.URL.Path, "/result")) {
			next.ServeHTTP(w, r)
			return
		}
		exclusive := r.Method != http.MethodGet && (strings.HasPrefix(r.URL.Path, "/api/session/uploads") || strings.HasPrefix(r.URL.Path, "/api/cli/sources") || strings.HasPrefix(r.URL.Path, "/api/session/blobs") || r.URL.Path == "/api/session/document" || r.URL.Path == "/api/session/save" || r.URL.Path == "/api/session/save-as" || r.URL.Path == "/api/session/close" || r.URL.Path == "/api/session/load-path" || r.URL.Path == "/api/session/new")
		if exclusive {
			s.documentGate.Lock()
			defer s.documentGate.Unlock()
		} else {
			s.documentGate.RLock()
			defer s.documentGate.RUnlock()
		}
		if documentID := r.Header.Get("X-Kavla-Document-ID"); documentID != "" && documentID != s.document.Manifest().DocumentID {
			writeAPIError(w, http.StatusConflict, fmt.Errorf("the active document changed; reload the canvas"))
			return
		}
		next.ServeHTTP(w, r)
	})
}
