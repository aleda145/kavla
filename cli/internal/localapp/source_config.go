package localapp

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
	"github.com/aleda145/kavla/cli/internal/session"
	"github.com/aleda145/kavla/cli/internal/sources"
)

var cliSourceNamePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]*$`)

type cliSourceDefinitionResponse struct {
	Type            string `json:"type"`
	Label           string `json:"label"`
	ConnectionLabel string `json:"connectionLabel"`
	ConnectionHelp  string `json:"connectionHelp"`
	ConnectionKind  string `json:"connectionKind"`
}

type cliSourceResponse struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	Connection string `json:"connection"`
	Available  bool   `json:"available"`
	Error      string `json:"error,omitempty"`
}

type cliSourcesResponse struct {
	ConfigPath  string                        `json:"configPath"`
	Definitions []cliSourceDefinitionResponse `json:"definitions"`
	Sources     []cliSourceResponse           `json:"sources"`
}

type cliSourceMutationRequest struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	Connection string `json:"connection"`
}

func (s *Server) handleGetCLISources(w http.ResponseWriter, _ *http.Request) {
	s.sourceConfigMu.Lock()
	defer s.sourceConfigMu.Unlock()
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

	s.sourceConfigMu.Lock()
	defer s.sourceConfigMu.Unlock()
	config, err := kavlaconfig.LoadConfigAllowMissing()
	if err != nil {
		http.Error(w, "load CLI configuration: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if config.Sources == nil {
		config.Sources = make(map[string]kavlaconfig.SourceConfig)
	}

	name := strings.TrimSpace(request.Name)
	if !cliSourceNamePattern.MatchString(name) {
		http.Error(w, "source name must start with a letter and contain only letters, numbers, and underscores", http.StatusBadRequest)
		return
	}
	if originalName != "" {
		if _, exists := config.Sources[originalName]; !exists {
			http.Error(w, fmt.Sprintf("source %q does not exist", originalName), http.StatusNotFound)
			return
		}
	}
	if _, exists := config.Sources[name]; exists && (originalName == "" || name != originalName) {
		http.Error(w, fmt.Sprintf("source %q already exists", name), http.StatusConflict)
		return
	}

	definition, exists := sources.BuiltInDefinitionMap()[strings.ToLower(strings.TrimSpace(request.Type))]
	if !exists {
		http.Error(w, fmt.Sprintf("unsupported source type %q", request.Type), http.StatusBadRequest)
		return
	}
	connection, err := definition.ResolveConnection(request.Connection)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if originalName != "" && originalName != name {
		delete(config.Sources, originalName)
	}
	config.Sources[name] = kavlaconfig.SourceConfig{Type: definition.Type, Connection: connection}
	if err := s.applyCLIConfig(config); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.writeCLISourcesResponse(w)
}

func (s *Server) handleDeleteCLISource(w http.ResponseWriter, r *http.Request) {
	s.sourceConfigMu.Lock()
	defer s.sourceConfigMu.Unlock()
	config, err := kavlaconfig.LoadConfigAllowMissing()
	if err != nil {
		http.Error(w, "load CLI configuration: "+err.Error(), http.StatusInternalServerError)
		return
	}
	name := r.PathValue("name")
	if _, exists := config.Sources[name]; !exists {
		http.Error(w, fmt.Sprintf("source %q does not exist", name), http.StatusNotFound)
		return
	}
	delete(config.Sources, name)
	if err := s.applyCLIConfig(config); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.writeCLISourcesResponse(w)
}

func (s *Server) applyCLIConfig(config *kavlaconfig.Config) error {
	nextSession := session.NewWithAllowedDirectories(config.Sources, []string{s.transientDir})
	nextSession.SetLogger(s.logCLIOutput)
	if s.verbose {
		nextSession.SetVerboseLogger(s.logCLIOutput)
	}
	if err := nextSession.Start(); err != nil {
		return fmt.Errorf("start updated CLI sources: %w", err)
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
	configPath, err := kavlaconfig.GetConfigPath()
	if err != nil {
		return cliSourcesResponse{}, fmt.Errorf("resolve CLI configuration path: %w", err)
	}
	statusByName := make(map[string]map[string]interface{})
	s.queriesMu.RLock()
	for _, status := range s.queries.SourceList() {
		name, _ := status["name"].(string)
		statusByName[name] = status
	}
	s.queriesMu.RUnlock()

	names := make([]string, 0, len(config.Sources))
	for name := range config.Sources {
		names = append(names, name)
	}
	slices.Sort(names)
	configuredSources := make([]cliSourceResponse, 0, len(names))
	for _, name := range names {
		configured := config.Sources[name]
		status := statusByName[name]
		available, _ := status["available"].(bool)
		errorMessage, _ := status["error"].(string)
		configuredSources = append(configuredSources, cliSourceResponse{
			Name: name, Type: configured.Type, Connection: configured.Connection, Available: available, Error: errorMessage,
		})
	}

	definitions := sources.BuiltInDefinitions()
	definitionResponses := make([]cliSourceDefinitionResponse, 0, len(definitions))
	for _, definition := range definitions {
		definitionResponses = append(definitionResponses, cliSourceDefinitionResponse{
			Type: definition.Type, Label: definition.Label, ConnectionLabel: definition.Prompt.Label,
			ConnectionHelp: definition.Prompt.Help, ConnectionKind: string(definition.Prompt.Kind),
		})
	}
	return cliSourcesResponse{ConfigPath: configPath, Definitions: definitionResponses, Sources: configuredSources}, nil
}

func (s *Server) handleCLISourcePaths(w http.ResponseWriter, r *http.Request) {
	requestedPath := strings.TrimSpace(r.URL.Query().Get("path"))
	if requestedPath == "" {
		var err error
		requestedPath, err = os.UserHomeDir()
		if err != nil {
			http.Error(w, "resolve home directory: "+err.Error(), http.StatusInternalServerError)
			return
		}
	}
	if !filepath.IsAbs(requestedPath) {
		http.Error(w, "source path must be absolute", http.StatusBadRequest)
		return
	}
	requestedPath = filepath.Clean(requestedPath)
	info, err := os.Stat(requestedPath)
	if err != nil || !info.IsDir() {
		http.Error(w, "source directory does not exist", http.StatusBadRequest)
		return
	}
	entries, err := os.ReadDir(requestedPath)
	if err != nil {
		http.Error(w, "read source directory: "+err.Error(), http.StatusForbidden)
		return
	}
	type pathEntry struct {
		Name string `json:"name"`
		Path string `json:"path"`
		Type string `json:"type"`
	}
	resultEntries := make([]pathEntry, 0, len(entries))
	for _, entry := range entries {
		entryPath := filepath.Join(requestedPath, entry.Name())
		entryInfo, err := entry.Info()
		if err != nil {
			continue
		}
		if entryInfo.IsDir() {
			resultEntries = append(resultEntries, pathEntry{Name: entry.Name(), Path: entryPath, Type: "directory"})
		} else if entryInfo.Mode().IsRegular() {
			resultEntries = append(resultEntries, pathEntry{Name: entry.Name(), Path: entryPath, Type: "file"})
		}
	}
	slices.SortFunc(resultEntries, func(left, right pathEntry) int {
		if left.Type != right.Type {
			if left.Type == "directory" {
				return -1
			}
			return 1
		}
		return strings.Compare(strings.ToLower(left.Name), strings.ToLower(right.Name))
	})
	homePath, _ := os.UserHomeDir()
	parentPath := filepath.Dir(requestedPath)
	if parentPath == requestedPath {
		parentPath = ""
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"path": requestedPath, "parentPath": parentPath, "homePath": homePath, "entries": resultEntries,
	}); err != nil && !errors.Is(err, http.ErrHandlerTimeout) {
		s.logCLIOutput("Could not encode CLI source path listing: %v\n", err)
	}
}
