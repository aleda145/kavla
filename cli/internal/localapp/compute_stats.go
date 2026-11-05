package localapp

import "net/http"

func (s *Server) handleComputeStats(w http.ResponseWriter, r *http.Request) {
	s.queriesMu.RLock()
	stats := s.queries.ComputeStats()
	s.queriesMu.RUnlock()
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, stats)
}
