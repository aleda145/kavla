package localapp

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func (s *Server) handleSourceSample(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	var request struct {
		TableRef string  `json:"tableRef"`
		Percent  float64 `json:"percent"`
		DryRun   bool    `json:"dryRun"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeAPIError(w, http.StatusBadRequest, fmt.Errorf("invalid sample request"))
		return
	}
	request.TableRef = strings.TrimSpace(request.TableRef)
	if request.TableRef == "" || math.IsNaN(request.Percent) || math.IsInf(request.Percent, 0) || request.Percent <= 0 || request.Percent >= 100 {
		writeAPIError(w, http.StatusBadRequest, fmt.Errorf("a source table and sample percentage between 0 and 100 are required"))
		return
	}
	started := time.Now()
	s.logCLIOutput("Sample requested: source=%s percent=%g dry_run=%t\n", request.TableRef, request.Percent, request.DryRun)
	querySession, done, err := s.beginQueryOperation()
	if err != nil {
		s.logCLIOutput("Sample could not start for %s: %v\n", request.TableRef, err)
		writeAPIError(w, http.StatusServiceUnavailable, err)
		return
	}
	defer done()
	ctx, cancel := querySession.OperationContext(r.Context())
	defer cancel()

	manifest := s.document.Manifest()
	sourceName := strings.Split(request.TableRef, ".")[0]
	if querySession.Sources()[sourceName].Type == "bigquery" {
		sample, err := querySession.PrepareBigQuerySample(ctx, request.TableRef, request.Percent, request.DryRun)
		if err != nil {
			s.logCLIOutput("BigQuery sample failed for %s after %s (percent=%g dry_run=%t): %v\n", request.TableRef, time.Since(started).Round(time.Millisecond), request.Percent, request.DryRun, err)
			writeAPIError(w, http.StatusUnprocessableEntity, err)
			return
		}
		if sample.Estimate != nil {
			s.logCLIOutput("BigQuery sample dry run finished for %s: %d estimated bytes (%s)\n", request.TableRef, sample.Estimate.BytesProcessed, time.Since(started).Round(time.Millisecond))
		} else {
			s.logCLIOutput("BigQuery sample ready: %s (%s)\n", sample.TableRef, time.Since(started).Round(time.Millisecond))
		}
		writeJSON(w, http.StatusOK, sample)
		return
	}
	if request.DryRun {
		writeAPIError(w, http.StatusBadRequest, fmt.Errorf("sample estimates are only available for BigQuery"))
		return
	}
	config, err := json.Marshal(querySession.Sources()[sourceName])
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, err)
		return
	}
	originalChecksum := ""
	for _, blob := range manifest.Blobs {
		if blob.TableName != "" && request.TableRef == "uploaded_files.main."+blob.TableName {
			originalChecksum = blob.SHA256
			break
		}
	}
	key := sha256.Sum256([]byte(fmt.Sprintf("sample-v1\x00%s\x00%g\x00%s\x00%s", request.TableRef, request.Percent, config, originalChecksum)))
	id := fmt.Sprintf("sample:%x", key)
	blob, err := s.document.BlobDescriptor(id)
	cached := err == nil
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		writeAPIError(w, http.StatusInternalServerError, err)
		return
	}
	if !cached {
		dir, err := os.MkdirTemp(s.transientDir, "source-sample-")
		if err != nil {
			writeAPIError(w, http.StatusInternalServerError, err)
			return
		}
		defer os.RemoveAll(dir)
		outputPath := filepath.Join(dir, "sample.parquet")
		s.logCLIOutput("Creating %g%% sample of %s\n", request.Percent, request.TableRef)
		if err := querySession.ExportSourceSample(ctx, request.TableRef, request.Percent, outputPath); err != nil {
			writeAPIError(w, http.StatusUnprocessableEntity, err)
			return
		}
		file, err := os.Open(outputPath)
		if err != nil {
			writeAPIError(w, http.StatusInternalServerError, err)
			return
		}
		defer file.Close()
		name := uniqueUploadName(fmt.Sprintf("_kavla_sample_%x", key[:16]), manifest.Blobs)
		fileName := sourceExportFileName("", request.TableRef, "parquet")
		fileName = strings.TrimSuffix(fileName, ".parquet") + fmt.Sprintf("_%g_percent.parquet", request.Percent)
		blob, err = s.document.PutBlob(id, BlobDescriptor{Kind: BlobKindSource, TableName: name, FileName: fileName, MIMEType: "application/vnd.apache.parquet"}, file)
		if err != nil {
			writeAPIError(w, http.StatusInternalServerError, err)
			return
		}
	}
	// Register lazily like an upload. The Parquet file survives worker restarts
	// and is saved in the document archive using the existing blob lifecycle.
	path, err := s.document.BlobURL(id)
	if err == nil {
		err = querySession.RegisterUploadedFile(ctx, blob.TableName, blob.FileName, path)
	}
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, err)
		return
	}
	s.logCLIOutput("Using cached %g%% sample of %s\n", request.Percent, request.TableRef)
	writeJSON(w, http.StatusOK, map[string]interface{}{"tableRef": "uploaded_files.main." + blob.TableName, "blob": blob})
}
