package localapp

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
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
	querySession, done, err := s.beginQueryOperation()
	if err != nil {
		writeAPIError(w, http.StatusServiceUnavailable, err)
		return
	}
	defer done()
	estimate, err := querySession.EstimateQuery(r.Context(), request.ExecutionEngine, request.SourceName, request.SQL)
	if err != nil {
		if r.Context().Err() == nil {
			writeAPIError(w, http.StatusUnprocessableEntity, err)
		}
		return
	}
	writeJSON(w, http.StatusOK, estimate)
}
