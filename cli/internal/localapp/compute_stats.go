package localapp

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"runtime"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
	"github.com/aleda145/kavla/cli/internal/memoryguard"
)

func (s *Server) handleComputeStats(w http.ResponseWriter, r *http.Request) {
	s.queriesMu.RLock()
	stats := s.queries.ComputeStats()
	s.queriesMu.RUnlock()
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, stats)
}

func (s *Server) handleComputeSettings(w http.ResponseWriter, r *http.Request) {
	s.sourceConfigMu.Lock()
	defer s.sourceConfigMu.Unlock()
	config, err := kavlaconfig.LoadConfigAllowMissing()
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, err)
		return
	}
	if r.Method == http.MethodPut {
		var settings *struct {
			kavlaconfig.MemoryConfig
			DuckDBThreads json.RawMessage `json:"duckdbThreads"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&settings); err != nil || settings == nil || decoder.Decode(new(interface{})) != io.EOF {
			http.Error(w, "Invalid compute settings", http.StatusBadRequest)
			return
		}
		switch settings.Enforcement {
		case "", "auto", "required", "off":
		default:
			http.Error(w, "Enforcement must be auto, required, or off", http.StatusBadRequest)
			return
		}
		config.Memory = settings.MemoryConfig
		// Older clients omit this field. An explicit null restores DuckDB's default.
		if settings.DuckDBThreads != nil {
			if err := json.Unmarshal(settings.DuckDBThreads, &config.DuckDBThreads); err != nil {
				http.Error(w, "DuckDB threads must be a positive integer or Auto", http.StatusBadRequest)
				return
			}
		}
		if err := config.Validate(); err != nil {
			writeAPIError(w, http.StatusBadRequest, err)
			return
		}
		if err := kavlaconfig.SaveConfig(config); err != nil {
			writeAPIError(w, http.StatusInternalServerError, err)
			return
		}
		s.logCLIOutput("Updated DuckDB settings for future worker starts")
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"memory":              config.Memory,
		"duckdbThreads":       config.DuckDBThreads,
		"availableCPUs":       runtime.NumCPU(),
		"availableMiB":        memoryguard.AvailableMiB(),
		"enforcementOverride": os.Getenv("KAVLA_MEMORY_ENFORCEMENT"),
	})
}

func (s *Server) handleComputeRestart(w http.ResponseWriter, r *http.Request) {
	session, done, err := s.beginQueryOperation()
	if err != nil {
		writeAPIError(w, http.StatusServiceUnavailable, err)
		return
	}
	defer done()
	if err := session.RestartCompute(r.Context()); err != nil {
		writeAPIError(w, http.StatusServiceUnavailable, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
