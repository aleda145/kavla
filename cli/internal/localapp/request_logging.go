package localapp

import (
	"io"
	"net/http"
	"strings"
	"time"
)

func (s *Server) logAPIRequests(mux *http.ServeMux, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Stream handlers need the original writer for flushing and upgrading.
		if strings.HasPrefix(r.URL.Path, "/api/") && !strings.HasSuffix(r.URL.Path, "/events") {
			if _, pattern := mux.Handler(r); strings.Contains(pattern, " /api/") {
				s.serveLoggedRequest(w, r, pattern, next)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) serveLoggedRequest(w http.ResponseWriter, r *http.Request, pattern string, next http.Handler) {
	started := time.Now()
	response := &loggedResponse{ResponseWriter: w}
	next.ServeHTTP(response, r)
	status := response.status
	if status == 0 {
		status = http.StatusOK
	}
	if s.verbose || (r.Context().Err() == nil && shouldLogAPIFailure(pattern, r.Method, status)) {
		// The route pattern omits query parameters and concrete resource IDs.
		reason := ""
		if response.reason != "" {
			reason = ": " + response.reason
		}
		s.logCLIOutput("%s — %d %s%s (%s)", pattern, status, http.StatusText(status), reason, time.Since(started).Round(time.Millisecond))
	}
}

func shouldLogAPIFailure(pattern, method string, status int) bool {
	if status >= http.StatusInternalServerError {
		return true
	}
	if status < http.StatusBadRequest || method == http.MethodGet || method == http.MethodHead {
		return false
	}
	if status == http.StatusUnprocessableEntity {
		switch pattern {
		case "POST /api/session/validate", "POST /api/session/queries", "POST /api/session/query-estimate":
			// Validation runs while editing. Queries and estimates log their own failures.
			return false
		}
	}
	return true
}

type loggedResponse struct {
	http.ResponseWriter
	status int
	reason string
}

func (w *loggedResponse) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *loggedResponse) WriteHeader(status int) {
	if w.status == 0 && status >= 200 {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *loggedResponse) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	if w.status >= http.StatusBadRequest && w.reason == "" {
		w.reason = apiFailureReason(string(p[:min(len(p), 4096)]))
	}
	return w.ResponseWriter.Write(p)
}

func apiFailureReason(body string) string {
	// Error responses may contain paths, SQL, or provider data. Log fixed
	// descriptions of recognized failures instead of copying response bodies.
	body = strings.ToLower(body)
	for _, failure := range []struct{ match, reason string }{
		{"does not own the canvas editor", "editor ownership lost"},
		{"active document changed", "stale canvas session"},
		{"canvas document has changed", "stale canvas session"},
		{"document changed on disk", "canvas changed on disk"},
		{"already exists", "name already exists"},
		{"already registered", "name already registered"},
		{"already open", "canvas already open"},
		{"is loaded; choose another filename", "canvas already loaded"},
		{"invalid request origin", "request origin rejected"},
		{"query result is not loaded", "query result needs to be rerun"},
		{"already working", "Agent run already active"},
		{"no longer active", "Agent run no longer active"},
		{"budget exhausted", "Agent generation budget exhausted"},
		{"permission denied", "permission denied"},
		{"no space left on device", "disk full"},
		{"request body too large", "request body too large"},
		{"deadline exceeded", "operation timed out"},
		{"timed out", "operation timed out"},
		{"exceeded its", "operation limit exceeded"},
		{"connection refused", "connection refused"},
		{"authentication failed", "authentication failed"},
		{"invalid", "invalid input"},
		{"does not exist", "file or resource does not exist"},
	} {
		if strings.Contains(body, failure.match) {
			return failure.reason
		}
	}
	return ""
}

func (w *loggedResponse) ReadFrom(r io.Reader) (int64, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return io.Copy(w.ResponseWriter, r)
}
