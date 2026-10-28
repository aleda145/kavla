package localapp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path"
)

type dbtSourceDefinition struct {
	Source     string `json:"source"`
	Table      string `json:"table"`
	Schema     string `json:"schema"`
	Identifier string `json:"identifier"`
	Path       string `json:"path"`
}

// A seed revision is a document-owned upload. The original CSV and its native
// table survive reopening or sharing the canvas, just like other uploads.
func (s *Server) handleDBTSeed(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	var request struct {
		BindingID string `json:"bindingId"`
		Path      string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeAPIError(w, 400, err)
		return
	}
	dbtMu.Lock()
	defer dbtMu.Unlock()
	_, bindings, err := dbtBindings()
	if err != nil {
		writeAPIError(w, 500, err)
		return
	}
	binding, ok := bindings[s.document.Path()]
	if !ok || binding.ID != request.BindingID {
		writeAPIError(w, 409, fmt.Errorf("connect the dbt project before importing its seeds"))
		return
	}
	project, err := scanDBTProject(binding)
	if err != nil {
		writeAPIError(w, 422, err)
		return
	}
	allowed := false
	for _, file := range project.Files {
		if file.Path == request.Path && file.Kind == "seed" && path.Ext(file.Path) == ".csv" {
			allowed = true
		}
	}
	if !allowed {
		writeAPIError(w, 400, fmt.Errorf("select a CSV in the project's seed paths"))
		return
	}
	root, err := os.OpenRoot(binding.Root)
	if err != nil {
		writeAPIError(w, 422, err)
		return
	}
	defer root.Close()
	data, _, err := dbtRead(root, request.Path, 64<<20)
	if err != nil {
		writeAPIError(w, 422, err)
		return
	}
	if len(data) > 64<<20 {
		writeAPIError(w, 422, fmt.Errorf("seed exceeds the 64 MiB import limit"))
		return
	}
	id := "dbt-seed:" + dbtHash(append([]byte(binding.ID+":"+request.Path+":"), data...))
	querySession, done, err := s.beginQueryOperation()
	if err != nil {
		writeAPIError(w, 503, err)
		return
	}
	defer done()
	_, blob, existsErr := s.document.BlobPath(id)
	if existsErr != nil {
		name := uniqueUploadName(uploadBaseName(path.Base(request.Path)), s.document.Manifest().Blobs)
		blob, err = s.document.PutBlob(id, BlobDescriptor{Kind: BlobKindSource, FileName: path.Base(request.Path), MIMEType: "text/csv", TableName: name}, bytes.NewReader(data))
		if err != nil {
			writeAPIError(w, 500, err)
			return
		}
		filePath, _, err := s.document.BlobPath(id)
		if err == nil {
			err = querySession.ImportUploadedFile(r.Context(), name, blob.FileName, filePath)
		}
		if err != nil {
			_ = querySession.DropUploadedFile(context.Background(), name)
			_ = s.document.DeleteBlob(id)
			writeAPIError(w, 422, err)
			return
		}
		s.broadcastCLISources()
	}
	tableRef := "uploaded_files.main." + blob.TableName
	schema, err := querySession.GetSourceSchema(r.Context(), tableRef)
	if err != nil {
		writeAPIError(w, 422, err)
		return
	}
	stats, err := querySession.GetSourceStats(r.Context(), tableRef)
	if err != nil {
		writeAPIError(w, 422, err)
		return
	}
	dbtJSON(w, map[string]any{"tableRef": tableRef, "schema": schema, "rowCount": stats["rowCount"], "blob": blob})
}
