package localapp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
	"github.com/aleda145/kavla/cli/internal/session"
	"github.com/aleda145/kavla/cli/internal/sources"
)

type cliSourcesResponse = sources.Configuration
type cliSourceMutationRequest = sources.SourceInput

func (s *Server) handleGetCLISources(w http.ResponseWriter, _ *http.Request) {
	s.sourceConfigMu.Lock()
	defer s.sourceConfigMu.Unlock()
	s.writeCLISourcesResponse(w)
}

func (s *Server) handleCreateCLISource(w http.ResponseWriter, r *http.Request) {
	s.mutateCLISource(w, r, "")
}

func (s *Server) handleUpdateCLISource(w http.ResponseWriter, r *http.Request) {
	s.mutateCLISource(w, r, r.PathValue("name"))
}

func (s *Server) mutateCLISource(w http.ResponseWriter, r *http.Request, originalName string) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	var request cliSourceMutationRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		http.Error(w, "invalid CLI source request", http.StatusBadRequest)
		return
	}
	action := "create"
	if r.Method == http.MethodPut {
		action = "update"
	}
	s.applyCLISourceChange(w, sources.ConfigChange{Action: action, OriginalName: originalName, Source: request})
}

func (s *Server) handleDeleteCLISource(w http.ResponseWriter, r *http.Request) {
	s.applyCLISourceChange(w, sources.ConfigChange{Action: "delete", Name: r.PathValue("name")})
}

func (s *Server) applyCLISourceChange(w http.ResponseWriter, change sources.ConfigChange) {
	s.sourceConfigMu.Lock()
	defer s.sourceConfigMu.Unlock()
	config, err := sources.PrepareConfigChange(change)
	if err != nil {
		http.Error(w, err.Error(), sources.ConfigurationErrorStatus(err))
		return
	}
	if err := s.applyCLIConfig(config); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.writeCLISourcesResponse(w)
}

func (s *Server) applyCLIConfig(config *kavlaconfig.Config) error {
	if s.canvases != nil {
		return s.canvases.applySources(config)
	}
	nextSession := session.NewWithAllowedDirectories(config.Sources, []string{s.transientDir, s.document.workingDir})
	nextSession.SetLogger(s.logCLIOutput)
	if s.verbose {
		nextSession.SetVerboseLogger(s.logCLIOutput)
	}
	if err := nextSession.Start(); err != nil {
		return fmt.Errorf("start updated CLI sources: %w", err)
	}

	if err := s.restoreUploads(context.Background(), nextSession); err != nil {
		_ = nextSession.Close()
		return err
	}
	s.workerMu.Lock()
	if s.closing {
		s.workerMu.Unlock()
		_ = nextSession.Close()
		return fmt.Errorf("Kavla is closing")
	}
	if s.reconfiguring {
		s.workerMu.Unlock()
		_ = nextSession.Close()
		return fmt.Errorf("Kavla CLI sources are already being updated")
	}
	s.reconfiguring = true
	s.workerMu.Unlock()
	resetReconfiguring := func() {
		s.workerMu.Lock()
		s.reconfiguring = false
		s.workerMu.Unlock()
	}

	if err := kavlaconfig.SaveConfig(config); err != nil {
		resetReconfiguring()
		_ = nextSession.Close()
		return fmt.Errorf("save CLI configuration: %w", err)
	}

	s.queriesMu.RLock()
	previousSession := s.queries
	s.queriesMu.RUnlock()
	previousSession.Cancel()
	s.workers.Wait()
	s.queriesMu.Lock()
	s.queries = nextSession
	s.queriesMu.Unlock()
	if err := previousSession.Close(); err != nil {
		s.logCLIOutput("Could not close previous CLI source session: %v\n", err)
	}
	resetReconfiguring()
	s.broadcastCLISources()
	return nil
}

func (s *Server) broadcastCLISources() {
	s.queriesMu.RLock()
	sourceList := s.queries.SourceList()
	s.queriesMu.RUnlock()
	s.broadcastRuntimeEvent(cliRuntimeEvent{name: "sources", data: sourceList})
}

func (s *Server) writeCLISourcesResponse(w http.ResponseWriter) {
	response, err := s.cliSourcesResponse()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		s.logCLIOutput("Could not encode CLI source configuration: %v\n", err)
	}
}

func (s *Server) cliSourcesResponse() (cliSourcesResponse, error) {
	config, err := kavlaconfig.LoadConfigAllowMissing()
	if err != nil {
		return cliSourcesResponse{}, fmt.Errorf("load CLI configuration: %w", err)
	}
	s.queriesMu.RLock()
	statuses := s.queries.SourceList()
	s.queriesMu.RUnlock()
	return sources.DescribeConfig(config.Sources, statuses, true)
}

func (s *Server) handleCLISourcePaths(w http.ResponseWriter, r *http.Request) {
	listing, err := sources.ListSourcePaths(r.URL.Query().Get("path"))
	if err != nil {
		http.Error(w, err.Error(), sources.ConfigurationErrorStatus(err))
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(listing); err != nil && !errors.Is(err, http.ErrHandlerTimeout) {
		s.logCLIOutput("Could not encode CLI source path listing: %v\n", err)
	}
}
