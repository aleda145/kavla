package localapp

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"unicode/utf8"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
	"github.com/google/uuid"
	"gopkg.in/yaml.v3"
)

const dbtMaxFileBytes = 256 << 10
const dbtMaxProjectBytes = 16 << 20
const dbtMaxFiles = 1000

// Serializes bindings and compare-and-swap writes across all canvases in this
// process, including two canvases connected to the same project.
var dbtMu sync.Mutex

type dbtBinding struct {
	ID         string `json:"id"`
	Root       string `json:"root"`
	SourceName string `json:"sourceName,omitempty"`
}

type dbtFile struct {
	Path      string   `json:"path"`
	Kind      string   `json:"kind"`
	Text      string   `json:"text"`
	Revision  string   `json:"revision"`
	ReadOnly  bool     `json:"readOnly"`
	Size      int64    `json:"size"`
	DependsOn []string `json:"dependsOn"`
}

type dbtProject struct {
	Binding       *dbtBinding           `json:"binding"`
	Name          string                `json:"name"`
	Files         []dbtFile             `json:"files"`
	Warnings      []string              `json:"warnings"`
	Sources       []dbtSourceDefinition `json:"sources"`
	Documentation []dbtDocumentation    `json:"documentation"`
}

type dbtConfig struct {
	Name      string   `yaml:"name"`
	Models    []string `yaml:"model-paths"`
	Seeds     []string `yaml:"seed-paths"`
	Tests     []string `yaml:"test-paths"`
	Analyses  []string `yaml:"analysis-paths"`
	Macros    []string `yaml:"macro-paths"`
	Snapshots []string `yaml:"snapshot-paths"`
	Docs      []string `yaml:"docs-paths"`
	Target    string   `yaml:"target-path"`
	Packages  string   `yaml:"packages-install-path"`
	Logs      string   `yaml:"log-path"`
}

func dbtBindings() (string, map[string]dbtBinding, error) {
	configPath, err := kavlaconfig.GetConfigPath()
	if err != nil {
		return "", nil, err
	}
	file := filepath.Join(filepath.Dir(configPath), "dbt-projects.json")
	bindings := make(map[string]dbtBinding)
	data, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		return file, bindings, nil
	}
	if err != nil {
		return "", nil, err
	}
	if err := json.Unmarshal(data, &bindings); err != nil {
		return "", nil, fmt.Errorf("read dbt connections: %w", err)
	}
	if bindings == nil {
		bindings = make(map[string]dbtBinding)
	}
	return file, bindings, nil
}

func saveDBTBindings(file string, bindings map[string]dbtBinding) error {
	data, err := json.MarshalIndent(bindings, "", "  ")
	if err != nil {
		return err
	}
	return atomicWriteFile(file, data, 0600)
}

func dbtJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("encode dbt response: %v", err)
	}
}

func (s *Server) handleDBTProject(w http.ResponseWriter, r *http.Request) {
	dbtMu.Lock()
	defer dbtMu.Unlock()
	_, bindings, err := dbtBindings()
	if err != nil {
		writeAPIError(w, 500, err)
		return
	}
	binding, ok := bindings[s.document.Path()]
	if !ok {
		dbtJSON(w, dbtProject{Files: []dbtFile{}, Warnings: []string{}})
		return
	}
	project, err := scanDBTProject(binding)
	if err != nil {
		writeAPIError(w, 422, fmt.Errorf("dbt project %s: %w", binding.Root, err))
		return
	}
	dbtJSON(w, project)
}

func (s *Server) handleDBTConnect(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	var request struct {
		Path       string `json:"path"`
		SourceName string `json:"sourceName"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeAPIError(w, 400, err)
		return
	}
	if filepath.Base(request.Path) == "dbt_project.yml" {
		request.Path = filepath.Dir(request.Path)
	}
	if !filepath.IsAbs(request.Path) {
		writeAPIError(w, 400, fmt.Errorf("choose an absolute project directory"))
		return
	}
	root, err := filepath.EvalSymlinks(filepath.Clean(request.Path))
	if err != nil {
		writeAPIError(w, 400, err)
		return
	}
	dbtMu.Lock()
	defer dbtMu.Unlock()
	file, bindings, err := dbtBindings()
	if err != nil {
		writeAPIError(w, 500, err)
		return
	}
	binding := dbtBinding{ID: uuid.NewString(), Root: root}
	if previous, ok := bindings[s.document.Path()]; ok && previous.Root == root {
		binding = previous
	}
	binding.SourceName = request.SourceName
	project, err := scanDBTProject(binding)
	if err != nil {
		writeAPIError(w, 422, err)
		return
	}
	bindings[s.document.Path()] = binding
	if err := saveDBTBindings(file, bindings); err != nil {
		writeAPIError(w, 500, err)
		return
	}
	dbtJSON(w, project)
}

func (s *Server) handleDBTDisconnect(w http.ResponseWriter, r *http.Request) {
	dbtMu.Lock()
	defer dbtMu.Unlock()
	file, bindings, err := dbtBindings()
	if err != nil {
		writeAPIError(w, 500, err)
		return
	}
	delete(bindings, s.document.Path())
	if err := saveDBTBindings(file, bindings); err != nil {
		writeAPIError(w, 500, err)
		return
	}
	dbtJSON(w, dbtProject{Files: []dbtFile{}, Warnings: []string{}})
}

func parseDBTConfig(data []byte) (dbtConfig, error) {
	var config dbtConfig
	if err := yaml.Unmarshal(data, &config); err != nil {
		return config, fmt.Errorf("read dbt_project.yml: %w", err)
	}
	if strings.TrimSpace(config.Name) == "" {
		return config, fmt.Errorf("dbt_project.yml must have a project name")
	}
	if config.Models == nil {
		config.Models = []string{"models"}
	}
	if config.Seeds == nil {
		config.Seeds = []string{"seeds"}
	}
	if config.Tests == nil {
		config.Tests = []string{"tests"}
	}
	if config.Analyses == nil {
		config.Analyses = []string{"analyses"}
	}
	if config.Macros == nil {
		config.Macros = []string{"macros"}
	}
	if config.Snapshots == nil {
		config.Snapshots = []string{"snapshots"}
	}
	if config.Target == "" {
		config.Target = "target"
	}
	if config.Packages == "" {
		config.Packages = "dbt_packages"
	}
	if config.Logs == "" {
		config.Logs = "logs"
	}
	for _, directories := range [][]string{config.Models, config.Seeds, config.Tests, config.Analyses, config.Macros, config.Snapshots, config.Docs, {config.Target, config.Packages, config.Logs}} {
		for _, directory := range directories {
			cleaned := path.Clean(filepath.ToSlash(directory))
			if !fs.ValidPath(cleaned) || strings.ContainsAny(cleaned, "{}\\") {
				return config, fmt.Errorf("dbt paths must be literal directories inside the project: %s", directory)
			}
		}
	}
	config.Target = path.Clean(filepath.ToSlash(config.Target))
	config.Packages = path.Clean(filepath.ToSlash(config.Packages))
	config.Logs = path.Clean(filepath.ToSlash(config.Logs))
	return config, nil
}

func dbtHash(data []byte) string {
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

// No project operation follows a symlink, reads a device, or escapes the root.
// os.Root additionally confines file access if a directory changes mid-request.
func dbtRead(root *os.Root, name string, limit int64) ([]byte, fs.FileInfo, error) {
	if !fs.ValidPath(name) || strings.Contains(name, "\\") {
		return nil, nil, fmt.Errorf("invalid project path %q", name)
	}
	parts := strings.Split(name, "/")
	for i := range parts {
		info, err := root.Lstat(strings.Join(parts[:i+1], "/"))
		if err != nil {
			return nil, nil, err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, nil, fmt.Errorf("symlinks are not supported: %s", name)
		}
		if i == len(parts)-1 && !info.Mode().IsRegular() {
			return nil, nil, fmt.Errorf("not a regular file: %s", name)
		}
	}
	file, err := root.Open(name)
	if err != nil {
		return nil, nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, nil, fmt.Errorf("not a regular file: %s", name)
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	return data, info, err
}

func scanDBTProject(binding dbtBinding) (*dbtProject, error) {
	root, err := os.OpenRoot(binding.Root)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	data, _, err := dbtRead(root, "dbt_project.yml", dbtMaxFileBytes)
	if err != nil {
		return nil, fmt.Errorf("open dbt_project.yml: %w", err)
	}
	if len(data) > dbtMaxFileBytes {
		return nil, fmt.Errorf("dbt_project.yml exceeds 256 KiB")
	}
	config, err := parseDBTConfig(data)
	if err != nil {
		return nil, err
	}
	project := &dbtProject{Binding: &binding, Name: config.Name, Files: []dbtFile{}, Warnings: []string{}}
	seen := make(map[string]bool)
	total := 0
	add := func(name, kind string) error {
		if seen[name] {
			return nil
		}
		seen[name] = true
		data, info, err := dbtRead(root, name, dbtMaxFileBytes)
		if err != nil {
			return err
		}
		readOnly := len(data) > dbtMaxFileBytes
		if readOnly {
			data = data[:4096]
			// Only remove a partial UTF-8 character at the preview boundary.
			for i := 0; i < 3 && !utf8.Valid(data); i++ {
				data = data[:len(data)-1]
			}
		}
		if !utf8.Valid(data) || strings.ContainsRune(string(data), 0) {
			project.Warnings = append(project.Warnings, "Skipped non-text file: "+name)
			return nil
		}
		total += len(data)
		if total > dbtMaxProjectBytes || len(project.Files) >= dbtMaxFiles {
			return fmt.Errorf("project exceeds the canvas import limit (1,000 files / 16 MiB of text)")
		}
		if readOnly {
			project.Warnings = append(project.Warnings, name+": read-only preview (file exceeds 256 KiB)")
		}
		revision := dbtHash(data)
		if readOnly {
			revision = dbtHash([]byte(fmt.Sprintf("%s:%d:%d", revision, info.Size(), info.ModTime().UnixNano())))
		}
		project.Files = append(project.Files, dbtFile{Path: name, Kind: kind, Text: string(data), Revision: revision, ReadOnly: readOnly, Size: info.Size(), DependsOn: []string{}})
		return nil
	}
	for _, name := range []string{"dbt_project.yml", "packages.yml", "dependencies.yml", "selectors.yml", ".dbtignore"} {
		if _, err := root.Lstat(name); errors.Is(err, os.ErrNotExist) {
			continue
		} else if err != nil {
			return nil, err
		}
		if err := add(name, "project"); err != nil {
			return nil, err
		}
	}
	groups := []struct {
		kind  string
		paths []string
	}{
		{"model", config.Models}, {"seed", config.Seeds}, {"test", config.Tests},
		{"analysis", config.Analyses}, {"macro", config.Macros}, {"snapshot", config.Snapshots}, {"docs", config.Docs},
	}
	for _, group := range groups {
		for _, directory := range group.paths {
			directory = path.Clean(filepath.ToSlash(directory))
			if !fs.ValidPath(directory) || strings.Contains(directory, "{{") {
				return nil, fmt.Errorf("%s path must be a literal directory inside the project: %s", group.kind, directory)
			}
			if _, err := root.Lstat(directory); errors.Is(err, os.ErrNotExist) {
				continue
			} else if err != nil {
				return nil, err
			}
			err := fs.WalkDir(root.FS(), directory, func(name string, entry fs.DirEntry, walkErr error) error {
				if walkErr != nil {
					return walkErr
				}
				if entry.Type()&os.ModeSymlink != 0 {
					project.Warnings = append(project.Warnings, "Skipped symlink: "+name)
					return nil
				}
				if entry.IsDir() {
					if name != "." && (strings.HasPrefix(entry.Name(), ".") || entry.Name() == "node_modules" || name == config.Target || name == config.Packages || name == config.Logs) {
						return fs.SkipDir
					}
					return nil
				}
				if strings.HasPrefix(entry.Name(), ".") || entry.Name() == "profiles.yml" || strings.EqualFold(entry.Name(), "README.md") {
					return nil
				}
				kind := group.kind
				switch strings.ToLower(path.Ext(name)) {
				case ".sql", ".py", ".csv":
				case ".yml", ".yaml":
					kind = "properties"
				case ".md":
					kind = "docs"
				default:
					return nil
				}
				return add(name, kind)
			})
			if err != nil {
				return nil, err
			}
		}
	}
	if seen[".dbtignore"] {
		project.Warnings = append(project.Warnings, "Files matched by .dbtignore are shown too; this canvas is a file view of the project.")
	}
	sort.Slice(project.Files, func(i, j int) bool { return project.Files[i].Path < project.Files[j].Path })
	dbtProperties(project)
	dbtLineage(project, root, config)
	return project, nil
}

var dbtRefPattern = regexp.MustCompile(`\b(ref|source)\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]+)['"]\s*)?\)`)
var dbtJinjaComments = regexp.MustCompile(`(?s)\{#.*?#\}`)
var dbtJinjaBlocks = regexp.MustCompile(`(?s)\{\{.*?\}\}|\{%.*?%\}`)
var dbtPythonCalls = regexp.MustCompile(`\bdbt\.(?:ref|source)\s*\([^\n]*?\)`)

func dbtLineage(project *dbtProject, root *os.Root, config dbtConfig) {
	byPath := make(map[string]*dbtFile)
	refs := make(map[string][]string)
	sources := make(map[string][]string)
	for i := range project.Files {
		file := &project.Files[i]
		byPath[file.Path] = file
		if file.Kind == "model" || file.Kind == "seed" || file.Kind == "snapshot" {
			name := strings.TrimSuffix(path.Base(file.Path), path.Ext(file.Path))
			refs[name] = append(refs[name], file.Path)
		}
	}
	for _, source := range project.Sources {
		sources[source.Source+"."+source.Table] = append(sources[source.Source+"."+source.Table], source.Path)
	}

	for i := range project.Files {
		file := &project.Files[i]
		if path.Ext(file.Path) != ".sql" && path.Ext(file.Path) != ".py" {
			continue
		}
		deps := make(map[string]bool)
		code := dbtJinjaComments.ReplaceAllString(file.Text, "")
		blocks := dbtJinjaBlocks.FindAllString(code, -1)
		if path.Ext(file.Path) == ".py" {
			blocks = dbtPythonCalls.FindAllString(code, -1)
		}
		for _, match := range dbtRefPattern.FindAllStringSubmatch(strings.Join(blocks, "\n"), -1) {
			var candidates []string
			if match[1] == "source" {
				candidates = sources[match[2]+"."+match[3]]
			} else if match[3] == "" {
				candidates = refs[match[2]]
			} else if match[2] == config.Name {
				candidates = refs[match[3]]
			}
			if len(candidates) == 1 && candidates[0] != file.Path {
				deps[candidates[0]] = true
			}
		}
		for dependency := range deps {
			file.DependsOn = append(file.DependsOn, dependency)
		}
		sort.Strings(file.DependsOn)
	}
	// A fresh dbt manifest resolves versioned refs and macro-generated lineage.
	// Never run dbt or trust compiled SQL as the editable source of a model.
	manifestPath := path.Join(filepath.ToSlash(config.Target), "manifest.json")
	data, manifestInfo, err := dbtRead(root, manifestPath, 32<<20)
	if errors.Is(err, os.ErrNotExist) {
		project.Warnings = append(project.Warnings, "Lineage uses literal ref() and source() calls. Run dbt parse externally for versioned or macro-generated dependencies.")
		return
	}
	if err != nil || len(data) > 32<<20 {
		project.Warnings = append(project.Warnings, "Could not read dbt manifest; using literal dependencies.")
		return
	}
	for _, file := range project.Files {
		info, err := root.Stat(file.Path)
		if err != nil || info.ModTime().After(manifestInfo.ModTime()) {
			project.Warnings = append(project.Warnings, "Project files changed since dbt parse; using literal dependencies until the manifest is refreshed.")
			return
		}
	}
	type node struct {
		Package   string `json:"package_name"`
		Path      string `json:"original_file_path"`
		RawCode   string `json:"raw_code"`
		RawSQL    string `json:"raw_sql"`
		DependsOn struct {
			Nodes []string `json:"nodes"`
		} `json:"depends_on"`
	}
	var manifest struct {
		Nodes   map[string]node `json:"nodes"`
		Sources map[string]node `json:"sources"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		project.Warnings = append(project.Warnings, "Invalid dbt manifest; using literal dependencies.")
		return
	}
	ids := make(map[string]string)
	for id, node := range manifest.Nodes {
		if node.Package == config.Name && byPath[node.Path] != nil {
			ids[id] = node.Path
		}
	}
	for id, node := range manifest.Sources {
		if node.Package == config.Name && byPath[node.Path] != nil {
			ids[id] = node.Path
		}
	}
	stale := false
	for _, node := range manifest.Nodes {
		file := byPath[node.Path]
		if file == nil || node.Package != config.Name || path.Ext(file.Path) != ".sql" {
			continue
		}
		raw := node.RawCode
		if raw == "" {
			raw = node.RawSQL
		}
		if raw != file.Text {
			stale = true
			continue
		}
		deps := make(map[string]bool)
		for _, id := range node.DependsOn.Nodes {
			if name := ids[id]; name != "" && name != file.Path {
				deps[name] = true
			}
		}
		file.DependsOn = []string{}
		for name := range deps {
			file.DependsOn = append(file.DependsOn, name)
		}
		sort.Strings(file.DependsOn)
	}
	if stale {
		project.Warnings = append(project.Warnings, "Some models changed since dbt parse; their lineage uses literal dependencies until the manifest is refreshed.")
	}
}

func (s *Server) handleDBTWrite(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
	var request struct {
		BindingID string `json:"bindingId"`
		Path      string `json:"path"`
		Revision  string `json:"revision"`
		Text      string `json:"text"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeAPIError(w, 400, err)
		return
	}
	if len(request.Text) > dbtMaxFileBytes || !utf8.ValidString(request.Text) || strings.ContainsRune(request.Text, 0) {
		writeAPIError(w, 400, fmt.Errorf("file must be UTF-8 text no larger than 256 KiB"))
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
	if !ok || request.BindingID != binding.ID {
		writeAPIError(w, 409, fmt.Errorf("dbt connection changed; reconnect this project"))
		return
	}
	project, err := scanDBTProject(binding)
	if err != nil {
		writeAPIError(w, 422, err)
		return
	}
	var current *dbtFile
	for i := range project.Files {
		if project.Files[i].Path == request.Path {
			current = &project.Files[i]
			break
		}
	}
	if current == nil {
		writeAPIError(w, 404, fmt.Errorf("file was removed or is outside the configured dbt paths"))
		return
	}
	if current.ReadOnly {
		writeAPIError(w, 400, fmt.Errorf("this file is a read-only preview"))
		return
	}
	if request.Path == "dbt_project.yml" {
		if _, err := parseDBTConfig([]byte(request.Text)); err != nil {
			writeAPIError(w, 422, err)
			return
		}
	}
	root, err := os.OpenRoot(binding.Root)
	if err != nil {
		writeAPIError(w, 500, err)
		return
	}
	defer root.Close()
	data, info, err := dbtRead(root, request.Path, dbtMaxFileBytes)
	if err != nil {
		writeAPIError(w, 409, err)
		return
	}
	if info.Mode().Perm()&0222 == 0 {
		writeAPIError(w, 403, fmt.Errorf("file is read-only on disk"))
		return
	}
	if dbtHash(data) != request.Revision {
		writeAPIError(w, 409, fmt.Errorf("file changed on disk; review both versions before saving"))
		return
	}
	// Prepare beside the destination, then recheck the revision immediately
	// before atomic replacement. External editors do not share our mutex.
	tempName := path.Join(path.Dir(request.Path), ".kavla-dbt-"+uuid.NewString())
	temp, err := root.OpenFile(tempName, os.O_WRONLY|os.O_CREATE|os.O_EXCL, info.Mode().Perm())
	if err != nil {
		writeAPIError(w, 500, err)
		return
	}
	defer root.Remove(tempName)
	writeErr := temp.Chmod(info.Mode().Perm())
	if writeErr == nil {
		_, writeErr = temp.WriteString(request.Text)
	}
	if writeErr == nil {
		writeErr = temp.Sync()
	}
	if closeErr := temp.Close(); writeErr == nil {
		writeErr = closeErr
	}
	if writeErr != nil {
		writeAPIError(w, 500, writeErr)
		return
	}
	latest, _, err := dbtRead(root, request.Path, dbtMaxFileBytes)
	if err != nil || dbtHash(latest) != request.Revision {
		writeAPIError(w, 409, fmt.Errorf("file changed while saving; review both versions"))
		return
	}
	if err := root.Rename(tempName, request.Path); err != nil {
		writeAPIError(w, 500, err)
		return
	}
	current.Text, current.Revision = request.Text, dbtHash([]byte(request.Text))
	current.Size = int64(len(request.Text))
	dbtJSON(w, current)
}
