package sources

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
)

var configurationNamePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]*$`)

type SourceInput struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	Connection string `json:"connection"`
}

type ConfigChange struct {
	Action       string      `json:"action"`
	OriginalName string      `json:"originalName"`
	Name         string      `json:"name"`
	Source       SourceInput `json:"source"`
}

type ConfigurationDefinition struct {
	Type            string `json:"type"`
	Label           string `json:"label"`
	ConnectionLabel string `json:"connectionLabel"`
	ConnectionHelp  string `json:"connectionHelp"`
	ConnectionKind  string `json:"connectionKind"`
}

type ConfiguredSource struct {
	Builtin    bool   `json:"builtin,omitempty"`
	Name       string `json:"name"`
	Type       string `json:"type"`
	Connection string `json:"connection"`
	Available  bool   `json:"available"`
	Error      string `json:"error,omitempty"`
}

type Configuration struct {
	ConfigPath  string                    `json:"configPath"`
	Definitions []ConfigurationDefinition `json:"definitions"`
	Sources     []ConfiguredSource        `json:"sources"`
}

type configurationError struct {
	status  int
	message string
}

func (e *configurationError) Error() string { return e.message }

func ConfigurationErrorStatus(err error) int {
	var requestError *configurationError
	if errors.As(err, &requestError) {
		return requestError.status
	}
	return http.StatusInternalServerError
}

// PrepareConfigChange validates a change without writing it. Callers activate the
// replacement session before persisting the config, so failures keep the old setup.
func PrepareConfigChange(request ConfigChange) (*kavlaconfig.Config, error) {
	config, err := kavlaconfig.LoadConfigAllowMissing()
	if err != nil {
		return nil, fmt.Errorf("load CLI configuration: %w", err)
	}
	if config.Sources == nil {
		config.Sources = make(map[string]kavlaconfig.SourceConfig)
	}
	if request.Action == "delete" {
		if strings.EqualFold(request.Name, "uploaded_files") {
			return nil, &configurationError{http.StatusBadRequest, "uploaded_files is a built-in document source"}
		}
		if _, exists := config.Sources[request.Name]; !exists {
			return nil, &configurationError{http.StatusNotFound, fmt.Sprintf("source %q does not exist", request.Name)}
		}
		delete(config.Sources, request.Name)
		return config, nil
	}
	if request.Action != "create" && request.Action != "update" {
		return nil, &configurationError{http.StatusBadRequest, fmt.Sprintf("unsupported source configuration action %q", request.Action)}
	}
	name := strings.TrimSpace(request.Source.Name)
	if strings.EqualFold(name, "uploaded_files") {
		return nil, &configurationError{http.StatusBadRequest, "uploaded_files is a built-in document source"}
	}
	if !configurationNamePattern.MatchString(name) {
		return nil, &configurationError{http.StatusBadRequest, "source name must start with a letter and contain only letters, numbers, and underscores"}
	}
	if request.Action == "update" {
		if _, exists := config.Sources[request.OriginalName]; !exists {
			return nil, &configurationError{http.StatusNotFound, fmt.Sprintf("source %q does not exist", request.OriginalName)}
		}
	}
	if _, exists := config.Sources[name]; exists && (request.Action == "create" || name != request.OriginalName) {
		return nil, &configurationError{http.StatusConflict, fmt.Sprintf("source %q already exists", name)}
	}
	definition, exists := BuiltInDefinitionMap()[strings.ToLower(strings.TrimSpace(request.Source.Type))]
	if !exists {
		return nil, &configurationError{http.StatusBadRequest, fmt.Sprintf("unsupported source type %q", request.Source.Type)}
	}
	connection, err := definition.ResolveConnection(request.Source.Connection)
	if err != nil {
		return nil, &configurationError{http.StatusBadRequest, err.Error()}
	}
	if request.Action == "update" && request.OriginalName != name {
		delete(config.Sources, request.OriginalName)
	}
	config.Sources[name] = kavlaconfig.SourceConfig{Type: definition.Type, Connection: connection}
	return config, nil
}

func DescribeConfig(configured map[string]kavlaconfig.SourceConfig, statuses []map[string]interface{}, includeUploadedFiles bool) (Configuration, error) {
	configPath, err := kavlaconfig.GetConfigPath()
	if err != nil {
		return Configuration{}, fmt.Errorf("resolve CLI configuration path: %w", err)
	}
	statusByName := make(map[string]map[string]interface{}, len(statuses))
	for _, status := range statuses {
		name, _ := status["name"].(string)
		statusByName[name] = status
	}
	names := make([]string, 0, len(configured))
	for name := range configured {
		names = append(names, name)
	}
	slices.Sort(names)
	result := Configuration{ConfigPath: configPath, Definitions: []ConfigurationDefinition{}, Sources: []ConfiguredSource{}}
	if includeUploadedFiles {
		result.Sources = append(result.Sources, ConfiguredSource{Name: "uploaded_files", Type: "duckdb", Available: true, Builtin: true})
	}
	for _, name := range names {
		source := configured[name]
		status := statusByName[name]
		available, _ := status["available"].(bool)
		errorMessage, _ := status["error"].(string)
		result.Sources = append(result.Sources, ConfiguredSource{
			Name: name, Type: source.Type, Connection: source.Connection, Available: available, Error: errorMessage,
		})
	}
	for _, definition := range BuiltInDefinitions() {
		result.Definitions = append(result.Definitions, ConfigurationDefinition{
			Type: definition.Type, Label: definition.Label, ConnectionLabel: definition.Prompt.Label,
			ConnectionHelp: definition.Prompt.Help, ConnectionKind: string(definition.Prompt.Kind),
		})
	}
	return result, nil
}

type SourcePathEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Type string `json:"type"`
}

type SourcePathListing struct {
	Path       string            `json:"path"`
	ParentPath string            `json:"parentPath"`
	HomePath   string            `json:"homePath"`
	Entries    []SourcePathEntry `json:"entries"`
}

func ListSourcePaths(path string) (SourcePathListing, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return SourcePathListing{}, fmt.Errorf("resolve home directory: %w", err)
	}
	path = strings.TrimSpace(path)
	if path == "" {
		path = home
	}
	if !filepath.IsAbs(path) {
		return SourcePathListing{}, &configurationError{http.StatusBadRequest, "source path must be absolute"}
	}
	path = filepath.Clean(path)
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		return SourcePathListing{}, &configurationError{http.StatusBadRequest, "source directory does not exist"}
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return SourcePathListing{}, &configurationError{http.StatusForbidden, "read source directory: " + err.Error()}
	}
	result := SourcePathListing{Path: path, ParentPath: filepath.Dir(path), HomePath: home, Entries: []SourcePathEntry{}}
	if result.ParentPath == path {
		result.ParentPath = ""
	}
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			continue
		}
		kind := "file"
		if info.IsDir() {
			kind = "directory"
		} else if !info.Mode().IsRegular() {
			continue
		}
		result.Entries = append(result.Entries, SourcePathEntry{Name: entry.Name(), Path: filepath.Join(path, entry.Name()), Type: kind})
	}
	slices.SortFunc(result.Entries, func(a, b SourcePathEntry) int {
		if a.Type != b.Type {
			return strings.Compare(a.Type, b.Type)
		}
		return strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name))
	})
	return result, nil
}
