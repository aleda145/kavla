package localapp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
)

// The listener owns the registry; a Server remains a single document runtime.
// Names belong to server-side files, not to IDs inside portable archives.
type canvasRegistry struct {
	mu       sync.Mutex
	settings sync.RWMutex
	root     *Server
	path     string
	files    map[string]string
	runtimes map[string]*Server
	last     string
	closing  bool
}

type savedCanvasRegistry struct {
	Files map[string]string `json:"files"`
	Last  string            `json:"last"`
}

func canonicalDocumentPath(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err == nil {
		return resolved, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(absolute))
	if err != nil {
		return "", err
	}
	return filepath.Join(parent, filepath.Base(absolute)), nil
}

func newCanvasRegistry(root *Server) (*canvasRegistry, error) {
	configPath, err := kavlaconfig.GetConfigPath()
	if err != nil {
		return nil, err
	}
	registry := &canvasRegistry{root: root, path: filepath.Join(filepath.Dir(configPath), "canvases.json"), files: make(map[string]string), runtimes: make(map[string]*Server)}
	data, err := os.ReadFile(registry.path)
	if err == nil {
		var saved savedCanvasRegistry
		if err := json.Unmarshal(data, &saved); err != nil {
			return nil, fmt.Errorf("read canvas registry: %w", err)
		}
		if saved.Files != nil {
			registry.files = saved.Files
		}
		registry.last = saved.Last
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	name, path, err := registry.checkPath(root.document.Path())
	if err != nil {
		return nil, err
	}
	registry.files[name] = path
	registry.last = name
	if err := registry.save(); err != nil {
		return nil, err
	}
	root.document.mu.Lock()
	root.document.path = path
	root.document.mu.Unlock()
	root.canvases, root.canvasName = registry, name
	registry.runtimes[name] = root
	return registry, nil
}

// Called with mu held once the registry has been published.
func (c *canvasRegistry) checkPath(path string) (string, string, error) {
	path, err := canonicalDocumentPath(path)
	if err != nil {
		return "", "", err
	}
	if !strings.EqualFold(filepath.Ext(path), ".kavla") {
		return "", "", fmt.Errorf("select a .kavla document")
	}
	name := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\\r\n\x00") {
		return "", "", fmt.Errorf("invalid canvas filename")
	}
	if strings.EqualFold(name, "api") || strings.EqualFold(name, "assets") {
		return "", "", fmt.Errorf("%q is reserved by Kavla; choose another filename", name)
	}
	// Public assets occupy root URL names as well.
	if file, err := c.root.assets.Open(name); err == nil {
		file.Close()
		return "", "", fmt.Errorf("%q is reserved by Kavla; choose another filename", name)
	}
	for existingName, existingPath := range c.files {
		if existingPath == path {
			return existingName, path, nil
		}
		if strings.EqualFold(existingName, name) {
			return "", "", fmt.Errorf("a canvas named %q is already registered; choose a unique filename", name)
		}
	}
	return name, path, nil
}

func (c *canvasRegistry) save() error {
	data, err := json.MarshalIndent(savedCanvasRegistry{Files: c.files, Last: c.last}, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(c.path), 0700); err != nil {
		return err
	}
	return atomicWriteFile(c.path, data, 0600)
}

func (s *Server) canvasURL() string {
	if s.canvases != nil {
		s.canvases.mu.Lock()
		defer s.canvases.mu.Unlock()
	}
	return "/" + url.PathEscape(s.canvasName)
}
func (s *Server) scopedURL(path string) string {
	if s.canvases == nil {
		return path
	}
	return s.canvasURL() + path
}

func (c *canvasRegistry) runtime(name string) (*Server, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closing {
		return nil, fmt.Errorf("Kavla is closing")
	}
	if runtime := c.runtimes[name]; runtime != nil {
		return runtime, nil
	}
	path, exists := c.files[name]
	if !exists {
		return nil, os.ErrNotExist
	}
	// OpenDocument also creates new documents. A bookmark must never do that.
	if info, err := os.Stat(path); err != nil {
		return nil, err
	} else if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("canvas is not a regular file")
	}
	document, err := OpenDocument(path)
	if err != nil {
		return nil, err
	}
	config, err := kavlaconfig.LoadConfigAllowMissing()
	if err != nil {
		document.CleanupWorkingCopy()
		return nil, err
	}
	runtime, err := NewServer(document, c.root.assets, config.Sources, c.root.verbose)
	if err != nil {
		document.CleanupWorkingCopy()
		return nil, err
	}
	runtime.canvases, runtime.canvasName = c, name
	c.runtimes[name] = runtime
	return runtime, nil
}

func (c *canvasRegistry) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/" {
		c.mu.Lock()
		name := c.last
		c.mu.Unlock()
		w.Header().Set("Cache-Control", "no-store")
		http.Redirect(w, r, "/"+url.PathEscape(name), http.StatusTemporaryRedirect)
		return
	}
	parts := strings.SplitN(strings.TrimPrefix(r.URL.EscapedPath(), "/"), "/", 2)
	name, err := url.PathUnescape(parts[0])
	if err != nil {
		http.Error(w, "invalid canvas URL", http.StatusBadRequest)
		return
	}
	if name == "api" {
		http.NotFound(w, r)
		return
	}
	c.mu.Lock()
	_, registered := c.files[name]
	c.mu.Unlock()
	if !registered {
		if file, err := c.root.assets.Open(strings.TrimPrefix(r.URL.Path, "/")); err == nil {
			file.Close()
			c.root.handleStatic(w, r)
		} else {
			http.Error(w, "This canvas is not registered. Open its .kavla file from Kavla.", http.StatusNotFound)
		}
		return
	}
	apiPath, escapedAPIPath := "", ""
	if len(parts) == 2 {
		escapedAPIPath = "/" + parts[1]
		apiPath, err = url.PathUnescape(escapedAPIPath)
		if err != nil {
			http.Error(w, "invalid API URL", http.StatusBadRequest)
			return
		}
	}
	stream := strings.HasSuffix(apiPath, "/events")
	sharedMutation := r.Method != http.MethodGet && (strings.HasPrefix(apiPath, "/api/cli/sources") || apiPath == "/api/agent/auth")
	if !stream {
		if sharedMutation {
			c.settings.Lock()
			defer c.settings.Unlock()
		} else {
			c.settings.RLock()
			defer c.settings.RUnlock()
		}
	}
	if stream {
		c.settings.RLock()
	}
	runtime, err := c.runtime(name)
	if stream {
		c.settings.RUnlock()
	}
	if err != nil {
		http.Error(w, "Could not open canvas: "+err.Error(), http.StatusNotFound)
		return
	}
	if apiPath == "" || apiPath == "/" {
		if r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		c.mu.Lock()
		previous := c.last
		c.last = name
		err := c.save()
		if err != nil {
			c.last = previous
		} else {
			runtime.notifyDocumentChanged()
		}
		c.mu.Unlock()
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		request := r.Clone(r.Context())
		request.URL.Path = "/"
		request.URL.RawPath = ""
		runtime.handleStatic(w, request)
		return
	}
	if !strings.HasPrefix(apiPath, "/api/") && apiPath != "/api" {
		http.NotFound(w, r)
		return
	}
	if apiPath == "/api/cli/events" || apiPath == "/api/agent/events" {
		http.NotFound(w, r)
		return
	}
	request := r.Clone(r.Context())
	request.URL.Path, request.URL.RawPath = apiPath, escapedAPIPath
	// Streaming ownership is acquired in handleRuntimeEvents. Navigation and
	// file browsing remain available to a tab that could not acquire it.
	mutation := r.Method != http.MethodGet && apiPath != "/api/session/load-path" && apiPath != "/api/session/new"
	if mutation {
		runtime.ownerMu.RLock()
		defer runtime.ownerMu.RUnlock()
		if runtime.ownerToken == "" || runtime.ownerContext.Err() != nil || r.Header.Get("X-Kavla-Editor") != runtime.ownerToken {
			writeAPIError(w, http.StatusConflict, fmt.Errorf("this tab does not own the canvas editor; reconnect before changing it"))
			return
		}
		requestContext, cancel := context.WithCancel(r.Context())
		body := request.Body
		stop := context.AfterFunc(runtime.ownerContext, func() {
			cancel()
			if body != nil {
				_ = body.Close()
			}
		})
		defer cancel()
		defer stop()
		request = request.WithContext(requestContext)
	}
	if sharedMutation && apiPath == "/api/agent/auth" {
		for _, other := range c.snapshot() {
			other.agentMu.Lock()
			active := activeAgentRun(other.agentRun)
			other.agentMu.Unlock()
			if active {
				writeAPIError(w, 409, fmt.Errorf("stop active Agent runs before changing authentication"))
				return
			}
		}
	}
	runtime.canvasHandler.ServeHTTP(w, request)
}

func (c *canvasRegistry) snapshot() []*Server {
	c.mu.Lock()
	defer c.mu.Unlock()
	result := make([]*Server, 0, len(c.runtimes))
	for _, runtime := range c.runtimes {
		result = append(result, runtime)
	}
	return result
}

func (c *canvasRegistry) openPath(path string) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	name, path, err := c.checkPath(path)
	if err != nil {
		return "", err
	}
	if info, err := os.Stat(path); err != nil {
		return "", err
	} else if !info.Mode().IsRegular() {
		return "", fmt.Errorf("canvas is not a regular file")
	}
	previous, exists := c.files[name]
	c.files[name] = path
	if err := c.save(); err != nil {
		if exists {
			c.files[name] = previous
		} else {
			delete(c.files, name)
		}
		return "", err
	}
	return "/" + url.PathEscape(name), nil
}

func (c *canvasRegistry) newDocument(directory, filename string, overwrite bool, canvasJSON string) (*Server, error) {
	path, err := resolveSelectedDocumentPath(directory, filename)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	name, path, err := c.checkPath(path)
	if err != nil {
		return nil, err
	}
	if c.runtimes[name] != nil {
		return nil, fmt.Errorf("this canvas is loaded; choose another filename")
	}
	document := &Document{}
	if err := document.NewAtPath(path, []byte(canvasJSON), overwrite); err != nil {
		return nil, err
	}
	defer document.CleanupWorkingCopy()
	previous, exists := c.files[name]
	c.files[name] = path
	if err := c.save(); err != nil {
		if exists {
			c.files[name] = previous
		} else {
			delete(c.files, name)
		}
		return nil, err
	}
	// The actual runtime is opened on navigation. The response only needs the
	// saved document's name, file size and URL.
	return &Server{document: document, canvases: c, canvasName: name}, nil
}

func (c *canvasRegistry) saveAs(runtime *Server, path string, overwrite bool) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	name, path, err := c.checkPath(path)
	if err != nil {
		return err
	}
	if other := c.runtimes[name]; other != nil && other != runtime {
		return fmt.Errorf("this canvas is loaded; choose another filename")
	}
	if path != runtime.document.Path() && !overwrite {
		if _, err := os.Stat(path); err == nil {
			return os.ErrExist
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	oldName, oldPath, oldLast := runtime.canvasName, runtime.document.Path(), c.last
	previous, exists := c.files[name]
	c.files[name], c.last = path, name
	if err := c.save(); err != nil {
		if exists {
			c.files[name] = previous
		} else {
			delete(c.files, name)
		}
		c.last = oldLast
		return err
	}
	if err := runtime.document.SaveAs(path); err != nil {
		if exists {
			c.files[name] = previous
		} else {
			delete(c.files, name)
		}
		c.last = oldLast
		return errors.Join(err, c.save())
	}
	if oldPath != path {
		delete(c.runtimes, oldName)
	}
	runtime.canvasName = name
	c.runtimes[name] = runtime
	return nil
}

func (c *canvasRegistry) closeOthers(ctx context.Context) error {
	c.mu.Lock()
	c.closing = true
	c.mu.Unlock()
	for _, runtime := range c.snapshot() {
		runtime.queriesMu.RLock()
		runtime.queries.Cancel()
		runtime.queriesMu.RUnlock()
		runtime.closeAgent()
	}
	c.settings.Lock()
	defer c.settings.Unlock()
	var result error
	for _, runtime := range c.snapshot() {
		if runtime != c.root {
			result = errors.Join(result, runtime.Close(ctx))
		}
	}
	return result
}
