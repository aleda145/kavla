package localapp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/aleda145/kavla/cli/internal/engine"
	"github.com/aleda145/kavla/cli/internal/runner"
	"github.com/aleda145/kavla/cli/internal/session"
	"github.com/google/uuid"
)

func (s *Server) handleGetSourceSchemas(w http.ResponseWriter, r *http.Request) {
	querySession, done, err := s.beginQueryOperation()
	if err != nil {
		writeAPIError(w, http.StatusServiceUnavailable, err)
		return
	}
	defer done()
	schemas, err := querySession.GetSourceSchemas(r.Context(), r.PathValue("name"))
	if err != nil {
		writeAPIError(w, http.StatusUnprocessableEntity, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"schemas": schemas})
}

func (s *Server) handleStoreQuery(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Query      runner.QueryRequest `json:"query"`
		SourceName string              `json:"sourceName"`
		SchemaName string              `json:"schemaName"`
		TableName  string              `json:"tableName"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeAPIError(w, http.StatusBadRequest, fmt.Errorf("invalid Store request: %w", err))
		return
	}
	querySession, done, err := s.beginQueryOperation()
	if err != nil {
		writeAPIError(w, http.StatusServiceUnavailable, err)
		return
	}
	defer done()
	ctx, cancel := querySession.OperationContext(r.Context())
	defer cancel()
	result, err := querySession.StoreDestination(request.SourceName, strings.TrimSpace(request.SchemaName), strings.TrimSpace(request.TableName))
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, err)
		return
	}
	// This directory is already allowed by the session's locked configuration.
	directory, err := os.MkdirTemp(s.transientDir, "store-*")
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, err)
		return
	}
	defer os.RemoveAll(directory)
	snapshotPath := filepath.Join(directory, "result.parquet")
	if err := querySession.SnapshotQuery(ctx, request.Query, snapshotPath, result); err != nil {
		writeAPIError(w, http.StatusUnprocessableEntity, err)
		return
	}
	var blob *BlobDescriptor
	if result.SourceName == engine.UploadedFilesSource {
		blob, err = s.storeDocumentSnapshot(ctx, querySession, snapshotPath, result.TableName)
	} else {
		err = querySession.StoreSnapshot(ctx, snapshotPath, result)
	}
	if err != nil {
		writeAPIError(w, http.StatusUnprocessableEntity, err)
		return
	}
	s.logCLIOutput("Stored %d rows in %s\n", result.RowCount, result.TableRef)
	s.broadcastCLISources()
	writeJSON(w, http.StatusCreated, struct {
		*engine.StoredTable
		Blob *BlobDescriptor `json:"blob,omitempty"`
	}{result, blob})
}

func (s *Server) storeDocumentSnapshot(ctx context.Context, querySession *session.Session, path, tableName string) (*BlobDescriptor, error) {
	for _, blob := range s.document.Manifest().Blobs {
		if strings.EqualFold(blob.TableName, tableName) {
			return nil, fmt.Errorf("table uploaded_files.main.%s already exists", tableName)
		}
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	id := "upload:" + uuid.NewString()
	blob, err := s.document.PutBlob(id, BlobDescriptor{
		Kind:      BlobKindSource,
		FileName:  tableName + ".parquet",
		MIMEType:  "application/vnd.apache.parquet",
		TableName: tableName,
	}, file)
	if err != nil {
		return nil, err
	}
	if err := querySession.ImportUploadedFile(ctx, tableName, blob.FileName, path); err != nil {
		if cleanupErr := s.document.DeleteBlob(id); cleanupErr != nil {
			return nil, fmt.Errorf("import stored table: %w (remove blob: %v)", err, cleanupErr)
		}
		return nil, err
	}
	return &blob, nil
}
