package localapp

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

func (s *Server) handleQueryEstimate(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<20)
	var request struct {
		SQL             string `json:"sql"`
		SourceName      string `json:"sourceName"`
		ExecutionEngine string `json:"executionEngine"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeAPIError(w, http.StatusBadRequest, fmt.Errorf("invalid query estimate request"))
		return
	}
	if strings.TrimSpace(request.SQL) == "" || strings.TrimSpace(request.SourceName) == "" || strings.TrimSpace(request.ExecutionEngine) == "" {
		writeAPIError(w, http.StatusBadRequest, fmt.Errorf("sql, sourceName and executionEngine are required"))
		return
	}
	started := time.Now()
	s.logCLIOutput("Dry run requested for %s (%s)\n", request.SourceName, request.ExecutionEngine)
	querySession, done, err := s.beginQueryOperation()
	if err != nil {
		s.logCLIOutput("Dry run could not start for %s after %s: %v\n", request.SourceName, time.Since(started).Round(time.Millisecond), err)
		writeAPIError(w, http.StatusServiceUnavailable, err)
		return
	}
	defer done()
	estimate, err := querySession.EstimateQuery(r.Context(), request.ExecutionEngine, request.SourceName, request.SQL)
	if err != nil {
		s.logCLIOutput("Dry run failed for %s after %s: %v\n", request.SourceName, time.Since(started).Round(time.Millisecond), err)
		if r.Context().Err() == nil {
			writeAPIError(w, http.StatusUnprocessableEntity, err)
		}
		return
	}
	s.logCLIOutput("Dry run finished for %s in %s (%d bytes estimated)\n", request.SourceName, time.Since(started).Round(time.Millisecond), estimate.BytesProcessed)
	writeJSON(w, http.StatusOK, estimate)
}
