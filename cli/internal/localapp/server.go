package localapp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
	"github.com/aleda145/kavla/cli/internal/runner"
	"github.com/aleda145/kavla/cli/internal/session"
	"github.com/apache/arrow/go/v14/arrow"
	"github.com/apache/arrow/go/v14/arrow/ipc"
)

const maxCLIOutputLines = 50

type cliOutputLine struct {
	Line      string `json:"line"`
	Timestamp int64  `json:"timestamp"`
}

type transientResult struct {
	path       string
	descriptor BlobDescriptor
}

type cliRuntimeEvent struct {
	name string
	data interface{}
}

type Server struct {
	document *Document
	assets   fs.FS
	verbose  bool

	listener         net.Listener
	http             *http.Server
	baseURL          string
	queries          *session.Session
	queriesMu        sync.RWMutex
	transientDir     string
	transientMu      sync.Mutex
	transientResults map[string]transientResult

	eventMu               sync.Mutex
	eventSubscribers      map[chan cliRuntimeEvent]struct{}
	outputMu              sync.Mutex
	output                []cliOutputLine
	documentChangeMu      sync.RWMutex
	documentChangeHandler func(string, string)
	workerMu              sync.Mutex
	workers               sync.WaitGroup
	closing               bool
	reconfiguring         bool
	sourceConfigMu        sync.Mutex
	shutdownOnce          sync.Once
}

// SetDocumentChangeHandler registers a callback for successful document
// switches and renames. The desktop app uses it to keep its native title in
// sync with the active canvas.
func (s *Server) SetDocumentChangeHandler(handler func(documentName, documentPath string)) {
	s.documentChangeMu.Lock()
	s.documentChangeHandler = handler
	s.documentChangeMu.Unlock()
}

func (s *Server) notifyDocumentChanged() {
	documentName := s.document.Manifest().DocumentName
	documentPath := s.document.Path()
	s.documentChangeMu.RLock()
	handler := s.documentChangeHandler
	s.documentChangeMu.RUnlock()
	if handler != nil {
		handler(documentName, documentPath)
	}
}

func NewServer(document *Document, assets fs.FS, sources map[string]kavlaconfig.SourceConfig, verbose bool) (*Server, error) {
	transientDir, err := os.MkdirTemp("", "kavla-query-results-*")
	if err != nil {
		return nil, fmt.Errorf("create temporary query result directory: %w", err)
	}
	if err := os.Chmod(transientDir, 0700); err != nil {
		_ = os.RemoveAll(transientDir)
		return nil, fmt.Errorf("secure temporary query result directory: %w", err)
	}
	querySession := session.NewWithAllowedDirectories(sources, []string{transientDir})
	server := &Server{
		document:         document,
		assets:           assets,
		verbose:          verbose,
		queries:          querySession,
		transientDir:     transientDir,
		transientResults: make(map[string]transientResult),
		eventSubscribers: make(map[chan cliRuntimeEvent]struct{}),
	}
	querySession.SetLogger(server.logCLIOutput)
	if verbose {
		querySession.SetVerboseLogger(server.logCLIOutput)
	}
	if err := querySession.Start(); err != nil {
		_ = os.RemoveAll(transientDir)
		return nil, fmt.Errorf("start local query session: %w", err)
	}
	return server, nil
}

func (s *Server) logCLIOutput(format string, args ...interface{}) {
	line := fmt.Sprintf(format, args...)
	fmt.Print(line)
	entry := cliOutputLine{Line: line, Timestamp: time.Now().UnixMilli()}

	s.outputMu.Lock()
	s.output = append(s.output, entry)
	if len(s.output) > maxCLIOutputLines {
		s.output = append([]cliOutputLine(nil), s.output[len(s.output)-maxCLIOutputLines:]...)
	}
	s.outputMu.Unlock()

	s.broadcastRuntimeEvent(cliRuntimeEvent{name: "output", data: entry})
}

func (s *Server) broadcastRuntimeEvent(event cliRuntimeEvent) {
	s.eventMu.Lock()
	defer s.eventMu.Unlock()
	for subscriber := range s.eventSubscribers {
		select {
		case subscriber <- event:
		default:
			delete(s.eventSubscribers, subscriber)
			close(subscriber)
		}
	}
}

func (s *Server) closeRuntimeSubscribers() {
	s.eventMu.Lock()
	defer s.eventMu.Unlock()
	for subscriber := range s.eventSubscribers {
		delete(s.eventSubscribers, subscriber)
		close(subscriber)
	}
}

func (s *Server) cliOutputHistory() []cliOutputLine {
	s.outputMu.Lock()
	defer s.outputMu.Unlock()
	return append([]cliOutputLine(nil), s.output...)
}

func (s *Server) Start(host string, port int, fallbackIfPortIsBusy bool) (string, error) {
	host = strings.TrimSpace(host)
	if host == "" {
		return "", fmt.Errorf("listen host is required")
	}
	if port < 1 || port > 65535 {
		return "", fmt.Errorf("listen port must be between 1 and 65535")
	}
	listenAddress := net.JoinHostPort(host, fmt.Sprintf("%d", port))
	listener, err := net.Listen("tcp", listenAddress)
	usedFallbackPort := false
	if err != nil {
		if !fallbackIfPortIsBusy || !errors.Is(err, syscall.EADDRINUSE) {
			return "", fmt.Errorf("listen on %s: %w", listenAddress, err)
		}
		listener, err = net.Listen("tcp", net.JoinHostPort(host, "0"))
		if err != nil {
			return "", fmt.Errorf("listen on an available port after %s was busy: %w", listenAddress, err)
		}
		usedFallbackPort = true
	}
	tcpAddress, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		_ = listener.Close()
		return "", fmt.Errorf("resolve TCP listener address %s", listener.Addr())
	}
	actualPort := tcpAddress.Port
	if usedFallbackPort {
		fmt.Printf("Default port %d is already in use; using port %d instead.\n", port, actualPort)
	}
	internalHost := host
	advertisedHost := host
	if ip := net.ParseIP(host); ip != nil && ip.IsUnspecified() {
		advertisedHost = "localhost"
		if ip.To4() != nil {
			internalHost = "127.0.0.1"
		} else {
			internalHost = "::1"
		}
	}
	s.listener = listener
	s.baseURL = "http://" + net.JoinHostPort(internalHost, fmt.Sprintf("%d", actualPort))
	s.http = &http.Server{
		Handler:           s.routes(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	go func() {
		if err := s.http.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("Kavla local server stopped: %v", err)
		}
	}()
	launchURL := "http://" + net.JoinHostPort(advertisedHost, fmt.Sprintf("%d", actualPort))
	return launchURL + "/", nil
}

func (s *Server) Close(ctx context.Context) error {
	var closeErr error
	s.shutdownOnce.Do(func() {
		s.workerMu.Lock()
		s.closing = true
		s.workerMu.Unlock()

		s.closeRuntimeSubscribers()
		s.queriesMu.RLock()
		s.queries.Cancel()
		s.queriesMu.RUnlock()
		if s.http != nil {
			if err := s.http.Shutdown(ctx); closeErr == nil && err != nil {
				closeErr = err
			}
		}
		s.workers.Wait()
		if err := s.queries.Close(); closeErr == nil && err != nil {
			closeErr = err
		}

		if err := s.document.Save(); closeErr == nil && err != nil {
			closeErr = err
		}
		if err := s.document.CleanupWorkingCopy(); closeErr == nil && err != nil {
			closeErr = err
		}
		if err := os.RemoveAll(s.transientDir); closeErr == nil && err != nil {
			closeErr = fmt.Errorf("remove temporary query results: %w", err)
		}
	})
	return closeErr
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/session", s.handleSession)
	mux.HandleFunc("PUT /api/session/document", s.sameOriginMutation(s.handleDocument))
	mux.HandleFunc("POST /api/session/save", s.sameOriginMutation(s.handleSave))
	mux.HandleFunc("POST /api/session/save-as", s.sameOriginMutation(s.handleSaveAs))
	mux.HandleFunc("GET /api/session/directories", s.handleDirectories)
	mux.HandleFunc("POST /api/session/load-path", s.sameOriginMutation(s.handleLoadPath))
	mux.HandleFunc("POST /api/session/new", s.sameOriginMutation(s.handleNew))
	mux.HandleFunc("GET /api/cli/sources", s.handleGetCLISources)
	mux.HandleFunc("GET /api/cli/sources/{name}/tables", s.handleGetSourceTables)
	mux.HandleFunc("POST /api/cli/source-schema", s.sameOriginMutation(s.handleGetSourceSchema))
	mux.HandleFunc("POST /api/cli/source-stats", s.sameOriginMutation(s.handleGetSourceStats))
	mux.HandleFunc("POST /api/cli/source-export", s.sameOriginMutation(s.handleExportSourceTable))
	mux.HandleFunc("GET /api/cli/events", s.handleCLIEvents)
	mux.HandleFunc("POST /api/cli/sources", s.sameOriginMutation(s.handleCreateCLISource))
	mux.HandleFunc("PUT /api/cli/sources/{name}", s.sameOriginMutation(s.handleUpdateCLISource))
	mux.HandleFunc("DELETE /api/cli/sources/{name}", s.sameOriginMutation(s.handleDeleteCLISource))
	mux.HandleFunc("GET /api/cli/source-paths", s.handleCLISourcePaths)
	mux.HandleFunc("POST /api/session/close", s.sameOriginMutation(s.handleSave))
	mux.HandleFunc("GET /api/session/blobs/{id}", s.handleGetBlob)
	mux.HandleFunc("GET /api/session/query-results/{id}", s.handleGetTransientResult)
	mux.HandleFunc("POST /api/session/queries", s.sameOriginMutation(s.handleQuery))
	mux.HandleFunc("POST /api/session/queries/{shapeId}/export", s.sameOriginMutation(s.handleExportQueryResult))
	mux.HandleFunc("DELETE /api/session/queries/{shapeId}", s.sameOriginMutation(s.handleCancelQuery))
	mux.HandleFunc("GET /api/session/queries/{shapeId}/rows", s.handleQueryResultPage)
	mux.HandleFunc("DELETE /api/session/queries/{shapeId}/result", s.sameOriginMutation(s.handleDropQueryResult))
	mux.HandleFunc("POST /api/session/blobs/delete-for-shapes", s.sameOriginMutation(s.handleDeleteBlobsForShapes))
	mux.HandleFunc("PUT /api/session/blobs/{id}", s.sameOriginMutation(s.handlePutBlob))
	mux.HandleFunc("DELETE /api/session/blobs/{id}", s.sameOriginMutation(s.handleDeleteBlob))
	mux.HandleFunc("/", s.handleStatic)
	return s.securityHeaders(mux)
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		w.Header().Set("Content-Security-Policy", "default-src 'self'; base-uri 'none'; object-src 'none'; frame-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:")
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Cross-Origin-Embedder-Policy", "require-corp")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) sameOriginMutation(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !hasSameRequestOrigin(r) {
			http.Error(w, "invalid request origin", http.StatusForbidden)
			return
		}
		next(w, r)
	}
}

func hasSameRequestOrigin(r *http.Request) bool {
	origin, err := url.Parse(r.Header.Get("Origin"))
	if err != nil || (origin.Scheme != "http" && origin.Scheme != "https") {
		return false
	}
	if origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" {
		return false
	}
	return strings.EqualFold(origin.Host, r.Host)
}

func (s *Server) handleSession(w http.ResponseWriter, _ *http.Request) {
	manifest := s.document.Manifest()
	canvas := s.document.CanvasJSON()
	fileSize, err := currentDocumentFileSize(s.document.Path())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	response := struct {
		DocumentID   string           `json:"documentId"`
		DocumentName string           `json:"documentName"`
		FileSize     int64            `json:"fileSize"`
		CanvasJSON   *string          `json:"canvasJson"`
		Blobs        []BlobDescriptor `json:"blobs"`
	}{
		DocumentID:   manifest.DocumentID,
		DocumentName: manifest.DocumentName,
		FileSize:     fileSize,
		Blobs:        manifest.Blobs,
	}
	if len(canvas) > 0 {
		value := string(canvas)
		response.CanvasJSON = &value
	}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("encode session response: %v", err)
	}
}

func (s *Server) handleDocument(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 256<<20)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := s.document.StageCanvas(data); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleSave(w http.ResponseWriter, _ *http.Request) {
	if err := s.document.Save(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.writeSavedDocumentResponse(w)
}

func currentDocumentFileSize(documentPath string) (int64, error) {
	info, err := os.Stat(documentPath)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("inspect Kavla document size: %w", err)
	}
	return info.Size(), nil
}

func (s *Server) writeSavedDocumentResponse(w http.ResponseWriter) {
	fileSize, err := currentDocumentFileSize(s.document.Path())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	manifest := s.document.Manifest()
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"path":         s.document.Path(),
		"documentName": manifest.DocumentName,
		"fileSize":     fileSize,
	})
}

func (s *Server) handleDirectories(w http.ResponseWriter, r *http.Request) {
	requestedPath := r.URL.Query().Get("path")
	if requestedPath == "" {
		requestedPath = filepath.Dir(s.document.Path())
	} else if !filepath.IsAbs(requestedPath) {
		http.Error(w, "directory path must be absolute", http.StatusBadRequest)
		return
	}
	requestedPath = filepath.Clean(requestedPath)
	info, err := os.Stat(requestedPath)
	if err != nil {
		http.Error(w, "could not open directory: "+err.Error(), http.StatusBadRequest)
		return
	}
	if !info.IsDir() {
		http.Error(w, "selected path is not a directory", http.StatusBadRequest)
		return
	}
	directoryEntries, err := os.ReadDir(requestedPath)
	if err != nil {
		http.Error(w, "could not list directory: "+err.Error(), http.StatusForbidden)
		return
	}

	type directoryEntry struct {
		Name string `json:"name"`
		Path string `json:"path"`
		Type string `json:"type"`
	}
	entries := make([]directoryEntry, 0, len(directoryEntries))
	for _, entry := range directoryEntries {
		entryPath := filepath.Join(requestedPath, entry.Name())
		entryInfo, err := os.Stat(entryPath)
		if err != nil {
			continue
		}
		if entryInfo.IsDir() {
			entries = append(entries, directoryEntry{Name: entry.Name(), Path: entryPath, Type: "directory"})
			continue
		}
		if strings.EqualFold(filepath.Ext(entry.Name()), ".kavla") {
			entries = append(entries, directoryEntry{Name: entry.Name(), Path: entryPath, Type: "document"})
		}
	}
	homePath, _ := os.UserHomeDir()
	parentPath := filepath.Dir(requestedPath)
	if parentPath == requestedPath {
		parentPath = ""
	}
	response := struct {
		Path                string           `json:"path"`
		ParentPath          string           `json:"parentPath,omitempty"`
		HomePath            string           `json:"homePath,omitempty"`
		CurrentDocumentPath string           `json:"currentDocumentPath"`
		Entries             []directoryEntry `json:"entries"`
	}{
		Path:                requestedPath,
		ParentPath:          parentPath,
		HomePath:            homePath,
		CurrentDocumentPath: s.document.Path(),
		Entries:             entries,
	}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("encode directory listing: %v", err)
	}
}

func (s *Server) handleSaveAs(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	var request struct {
		Directory string `json:"directory"`
		FileName  string `json:"fileName"`
		Overwrite bool   `json:"overwrite"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		http.Error(w, "invalid save request", http.StatusBadRequest)
		return
	}
	if !filepath.IsAbs(request.Directory) {
		http.Error(w, "save directory must be absolute", http.StatusBadRequest)
		return
	}
	request.Directory = filepath.Clean(request.Directory)
	info, err := os.Stat(request.Directory)
	if err != nil || !info.IsDir() {
		http.Error(w, "save directory does not exist", http.StatusBadRequest)
		return
	}
	fileName := strings.TrimSpace(request.FileName)
	if !strings.EqualFold(filepath.Ext(fileName), ".kavla") {
		fileName += ".kavla"
	}
	if fileName == ".kavla" || filepath.Base(fileName) != fileName || strings.ContainsAny(fileName, "\r\n\x00") {
		http.Error(w, "invalid Kavla filename", http.StatusBadRequest)
		return
	}
	targetPath := filepath.Join(request.Directory, fileName)
	if filepath.Clean(targetPath) != filepath.Clean(s.document.Path()) && !request.Overwrite {
		if _, err := os.Stat(targetPath); err == nil {
			http.Error(w, "A Kavla document with this name already exists.", http.StatusConflict)
			return
		} else if !errors.Is(err, os.ErrNotExist) {
			http.Error(w, "could not inspect save path: "+err.Error(), http.StatusBadRequest)
			return
		}
	}
	if err := s.document.SaveAs(targetPath); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.notifyDocumentChanged()
	s.writeSavedDocumentResponse(w)
}

func (s *Server) handleLoadPath(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	var request struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		http.Error(w, "invalid load request", http.StatusBadRequest)
		return
	}
	if !filepath.IsAbs(request.Path) || !strings.EqualFold(filepath.Ext(request.Path), ".kavla") {
		http.Error(w, "select an absolute .kavla document path", http.StatusBadRequest)
		return
	}
	info, err := os.Stat(request.Path)
	if err != nil || !info.Mode().IsRegular() {
		http.Error(w, "selected Kavla document does not exist", http.StatusBadRequest)
		return
	}
	if err := s.document.OpenFromPath(filepath.Clean(request.Path)); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.notifyDocumentChanged()
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleNew(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 8<<20)
	var request struct {
		Directory  string `json:"directory"`
		FileName   string `json:"fileName"`
		Overwrite  bool   `json:"overwrite"`
		CanvasJSON string `json:"canvasJson"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		http.Error(w, "invalid new document request", http.StatusBadRequest)
		return
	}
	targetPath, err := resolveSelectedDocumentPath(request.Directory, request.FileName)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if !request.Overwrite {
		if _, err := os.Stat(targetPath); err == nil {
			http.Error(w, "A Kavla document with this name already exists.", http.StatusConflict)
			return
		} else if !errors.Is(err, os.ErrNotExist) {
			http.Error(w, "could not inspect new document path: "+err.Error(), http.StatusBadRequest)
			return
		}
	}
	if err := s.document.NewAtPath(targetPath, []byte(request.CanvasJSON), request.Overwrite); err != nil {
		if !request.Overwrite && errors.Is(err, os.ErrExist) {
			http.Error(w, "A Kavla document with this name already exists.", http.StatusConflict)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.notifyDocumentChanged()
	s.writeSavedDocumentResponse(w)
}

func resolveSelectedDocumentPath(directory, fileName string) (string, error) {
	if !filepath.IsAbs(directory) {
		return "", fmt.Errorf("document directory must be absolute")
	}
	directory = filepath.Clean(directory)
	info, err := os.Stat(directory)
	if err != nil || !info.IsDir() {
		return "", fmt.Errorf("document directory does not exist")
	}
	fileName = strings.TrimSpace(fileName)
	if !strings.EqualFold(filepath.Ext(fileName), ".kavla") {
		fileName += ".kavla"
	}
	if fileName == ".kavla" || filepath.Base(fileName) != fileName || strings.ContainsAny(fileName, "\r\n\x00") {
		return "", fmt.Errorf("invalid Kavla filename")
	}
	return filepath.Join(directory, fileName), nil
}

func (s *Server) handleGetBlob(w http.ResponseWriter, r *http.Request) {
	filePath, descriptor, err := s.document.BlobPath(r.PathValue("id"))
	if errors.Is(err, fs.ErrNotExist) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	contentType := descriptor.MIMEType
	if _, _, err := mime.ParseMediaType(contentType); err != nil {
		contentType = "application/octet-stream"
	}
	version := r.URL.Query().Get("v")
	if version != "" && version != descriptor.SHA256 {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("ETag", `"`+descriptor.SHA256+`"`)
	if version == descriptor.SHA256 {
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "private, max-age=0, must-revalidate")
	}
	if r.Header.Get("If-None-Match") == `"`+descriptor.SHA256+`"` {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": descriptor.FileName}))
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	http.ServeFile(w, r, filePath)
}

func (s *Server) handleGetTransientResult(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	s.transientMu.Lock()
	result, ok := s.transientResults[id]
	if ok {
		delete(s.transientResults, id)
	}
	s.transientMu.Unlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	defer os.Remove(result.path)

	w.Header().Set("Content-Type", result.descriptor.MIMEType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": result.descriptor.FileName}))
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	http.ServeFile(w, r, result.path)
}

func (s *Server) stageTransientResult(format runner.ResultFormat, data []byte) (string, error) {
	file, err := os.CreateTemp(s.transientDir, "result-*")
	if err != nil {
		return "", fmt.Errorf("create temporary query result: %w", err)
	}
	filePath := file.Name()
	cleanup := true
	defer func() {
		_ = file.Close()
		if cleanup {
			_ = os.Remove(filePath)
		}
	}()
	if _, err := file.Write(data); err != nil {
		return "", fmt.Errorf("write temporary query result: %w", err)
	}
	if err := file.Sync(); err != nil {
		return "", fmt.Errorf("sync temporary query result: %w", err)
	}
	if err := file.Close(); err != nil {
		return "", fmt.Errorf("close temporary query result: %w", err)
	}
	if err := os.Chmod(filePath, 0600); err != nil {
		return "", fmt.Errorf("secure temporary query result: %w", err)
	}

	id := filepath.Base(filePath)
	s.transientMu.Lock()
	s.transientResults[id] = transientResult{
		path: filePath,
		descriptor: BlobDescriptor{
			FileName: "query-result." + string(format),
			MIMEType: "application/octet-stream",
		},
	}
	s.transientMu.Unlock()
	cleanup = false
	return id, nil
}

func (s *Server) stageTransientFile(filePath, fileName, mimeType string) (string, error) {
	info, err := os.Stat(filePath)
	if err != nil {
		return "", fmt.Errorf("inspect temporary source export: %w", err)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("temporary source export is not a regular file")
	}
	if err := os.Chmod(filePath, 0600); err != nil {
		return "", fmt.Errorf("secure temporary source export: %w", err)
	}
	id := filepath.Base(filePath)
	s.transientMu.Lock()
	s.transientResults[id] = transientResult{
		path: filePath,
		descriptor: BlobDescriptor{
			FileName: fileName,
			MIMEType: mimeType,
			Size:     info.Size(),
		},
	}
	s.transientMu.Unlock()
	return id, nil
}

func (s *Server) discardTransientResult(id string) {
	s.transientMu.Lock()
	result, ok := s.transientResults[id]
	if ok {
		delete(s.transientResults, id)
	}
	s.transientMu.Unlock()
	if ok {
		_ = os.Remove(result.path)
	}
}

func (s *Server) handlePutBlob(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	descriptor, err := s.document.PutBlob(r.PathValue("id"), BlobDescriptor{
		Kind:     BlobKind(query.Get("kind")),
		ShapeID:  query.Get("shapeId"),
		FileName: query.Get("fileName"),
		MIMEType: query.Get("mimeType"),
	}, r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	if err := json.NewEncoder(w).Encode(descriptor); err != nil {
		log.Printf("encode blob response: %v", err)
	}
}

func (s *Server) handleDeleteBlob(w http.ResponseWriter, r *http.Request) {
	if err := s.document.DeleteBlob(r.PathValue("id")); errors.Is(err, fs.ErrNotExist) {
		http.NotFound(w, r)
		return
	} else if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	requested := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if requested == "api" || strings.HasPrefix(requested, "api/") {
		http.NotFound(w, r)
		return
	}
	if requested == "." || requested == "" {
		requested = "index.html"
	}
	if file, err := s.assets.Open(requested); err == nil {
		file.Close()
		if requested == "index.html" {
			w.Header().Set("Cache-Control", "no-store")
		} else if strings.HasPrefix(requested, "assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "public, max-age=3600")
		}
		if contentType := mime.TypeByExtension(path.Ext(requested)); contentType != "" {
			w.Header().Set("Content-Type", contentType)
		}
		http.FileServer(http.FS(s.assets)).ServeHTTP(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	r.URL.Path = "/"
	http.FileServer(http.FS(s.assets)).ServeHTTP(w, r)
}

func (s *Server) beginQueryOperation() (*session.Session, func(), error) {
	s.workerMu.Lock()
	if s.closing {
		s.workerMu.Unlock()
		return nil, nil, fmt.Errorf("Kavla is closing")
	}
	if s.reconfiguring {
		s.workerMu.Unlock()
		return nil, nil, fmt.Errorf("Kavla CLI sources are being updated")
	}
	s.queriesMu.RLock()
	querySession := s.queries
	s.queriesMu.RUnlock()
	s.workers.Add(1)
	s.workerMu.Unlock()
	return querySession, s.workers.Done, nil
}

func writeJSON(w http.ResponseWriter, status int, value interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("encode JSON response: %v", err)
	}
}

func writeAPIError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func (s *Server) handleGetSourceTables(w http.ResponseWriter, r *http.Request) {
	querySession, done, err := s.beginQueryOperation()
	if err != nil {
		writeAPIError(w, http.StatusServiceUnavailable, err)
		return
	}
	defer done()
	tables, err := querySession.GetTables(r.PathValue("name"))
	if err != nil {
		writeAPIError(w, http.StatusUnprocessableEntity, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"tables": tables})
}

func decodeTableReference(w http.ResponseWriter, r *http.Request) (string, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	var request struct {
		TableRef string `json:"tableRef"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeAPIError(w, http.StatusBadRequest, fmt.Errorf("invalid table request"))
		return "", false
	}
	request.TableRef = strings.TrimSpace(request.TableRef)
	if request.TableRef == "" {
		writeAPIError(w, http.StatusBadRequest, fmt.Errorf("tableRef is required"))
		return "", false
	}
	return request.TableRef, true
}

func (s *Server) handleGetSourceSchema(w http.ResponseWriter, r *http.Request) {
	tableRef, ok := decodeTableReference(w, r)
	if !ok {
		return
	}
	querySession, done, err := s.beginQueryOperation()
	if err != nil {
		writeAPIError(w, http.StatusServiceUnavailable, err)
		return
	}
	defer done()
	columns, err := querySession.GetSourceSchema(r.Context(), tableRef)
	if err != nil {
		writeAPIError(w, http.StatusUnprocessableEntity, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"columns": columns})
}

func (s *Server) handleGetSourceStats(w http.ResponseWriter, r *http.Request) {
	tableRef, ok := decodeTableReference(w, r)
	if !ok {
		return
	}
	querySession, done, err := s.beginQueryOperation()
	if err != nil {
		writeAPIError(w, http.StatusServiceUnavailable, err)
		return
	}
	defer done()
	stats, err := querySession.GetSourceStats(r.Context(), tableRef)
	if err != nil {
		writeAPIError(w, http.StatusUnprocessableEntity, err)
		return
	}
	writeJSON(w, http.StatusOK, stats)
}

func (s *Server) handleExportSourceTable(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	var request struct {
		TableRef string `json:"tableRef"`
		Format   string `json:"format"`
		FileName string `json:"fileName"`
		RowCount *int64 `json:"rowCount"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeAPIError(w, http.StatusBadRequest, fmt.Errorf("invalid source export request"))
		return
	}
	request.TableRef = strings.TrimSpace(request.TableRef)
	request.Format = strings.ToLower(strings.TrimSpace(request.Format))
	if request.TableRef == "" {
		writeAPIError(w, http.StatusBadRequest, fmt.Errorf("tableRef is required"))
		return
	}
	if request.Format != "csv" && request.Format != "parquet" {
		writeAPIError(w, http.StatusBadRequest, fmt.Errorf("format must be csv or parquet"))
		return
	}

	file, err := os.CreateTemp(s.transientDir, "source-export-*."+request.Format)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, fmt.Errorf("create source export: %w", err))
		return
	}
	outputPath := file.Name()
	if err := file.Close(); err != nil {
		_ = os.Remove(outputPath)
		writeAPIError(w, http.StatusInternalServerError, fmt.Errorf("close source export placeholder: %w", err))
		return
	}
	if err := os.Remove(outputPath); err != nil {
		writeAPIError(w, http.StatusInternalServerError, fmt.Errorf("prepare source export path: %w", err))
		return
	}

	querySession, done, err := s.beginQueryOperation()
	if err != nil {
		writeAPIError(w, http.StatusServiceUnavailable, err)
		return
	}
	defer done()
	if err := querySession.ExportSourceTable(r.Context(), request.TableRef, request.Format, outputPath); err != nil {
		_ = os.Remove(outputPath)
		writeAPIError(w, http.StatusUnprocessableEntity, err)
		return
	}
	fileInfo, err := os.Stat(outputPath)
	if err != nil {
		_ = os.Remove(outputPath)
		writeAPIError(w, http.StatusInternalServerError, fmt.Errorf("inspect source export: %w", err))
		return
	}

	fileName := sourceExportFileName(request.FileName, request.TableRef, request.Format)
	mimeType := "application/vnd.apache.parquet"
	if request.Format == "csv" {
		mimeType = "text/csv; charset=utf-8"
	}
	id, err := s.stageTransientFile(outputPath, fileName, mimeType)
	if err != nil {
		_ = os.Remove(outputPath)
		writeAPIError(w, http.StatusInternalServerError, err)
		return
	}
	s.logExport("source", request.TableRef, request.RowCount, request.Format, fileInfo.Size())
	writeJSON(w, http.StatusCreated, map[string]string{
		"downloadUrl": "/api/session/query-results/" + url.PathEscape(id),
		"fileName":    fileName,
	})
}

func (s *Server) handleExportQueryResult(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	var request struct {
		Format   string `json:"format"`
		FileName string `json:"fileName"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeAPIError(w, http.StatusBadRequest, fmt.Errorf("invalid query result export request"))
		return
	}
	shapeID := strings.TrimSpace(r.PathValue("shapeId"))
	request.Format = strings.ToLower(strings.TrimSpace(request.Format))
	if shapeID == "" {
		writeAPIError(w, http.StatusBadRequest, fmt.Errorf("shapeId is required"))
		return
	}
	if request.Format != "csv" && request.Format != "parquet" {
		writeAPIError(w, http.StatusBadRequest, fmt.Errorf("format must be csv or parquet"))
		return
	}

	querySession, done, err := s.beginQueryOperation()
	if err != nil {
		writeAPIError(w, http.StatusServiceUnavailable, err)
		return
	}
	defer done()
	if !querySession.HasQueryResult(shapeID) {
		writeAPIError(w, http.StatusNotFound, fmt.Errorf("query result is not loaded; run the query to load it"))
		return
	}

	file, err := os.CreateTemp(s.transientDir, "query-export-*."+request.Format)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, fmt.Errorf("create query result export: %w", err))
		return
	}
	outputPath := file.Name()
	if err := file.Close(); err != nil {
		_ = os.Remove(outputPath)
		writeAPIError(w, http.StatusInternalServerError, fmt.Errorf("close query result export placeholder: %w", err))
		return
	}
	if err := os.Remove(outputPath); err != nil {
		writeAPIError(w, http.StatusInternalServerError, fmt.Errorf("prepare query result export path: %w", err))
		return
	}
	resultMetadata, err := querySession.ExportQueryResult(r.Context(), shapeID, request.Format, outputPath)
	if err != nil {
		_ = os.Remove(outputPath)
		writeAPIError(w, http.StatusUnprocessableEntity, err)
		return
	}
	fileInfo, err := os.Stat(outputPath)
	if err != nil {
		_ = os.Remove(outputPath)
		writeAPIError(w, http.StatusInternalServerError, fmt.Errorf("inspect query result export: %w", err))
		return
	}

	fileName := sourceExportFileName(request.FileName, shapeID, request.Format)
	mimeType := "application/vnd.apache.parquet"
	if request.Format == "csv" {
		mimeType = "text/csv; charset=utf-8"
	}
	id, err := s.stageTransientFile(outputPath, fileName, mimeType)
	if err != nil {
		_ = os.Remove(outputPath)
		writeAPIError(w, http.StatusInternalServerError, err)
		return
	}
	s.logExport("query", resultMetadata.Name, &resultMetadata.RowCount, request.Format, fileInfo.Size())
	writeJSON(w, http.StatusCreated, map[string]string{
		"downloadUrl": "/api/session/query-results/" + url.PathEscape(id),
		"fileName":    fileName,
	})
}

func (s *Server) logExport(kind, name string, rowCount *int64, format string, size int64) {
	rowLabel := "unknown rows"
	if rowCount != nil {
		rowLabel = fmt.Sprintf("%d rows", *rowCount)
	}
	s.logCLIOutput(
		"Exported %s '%s' as %s: %s, %s\n",
		kind,
		name,
		strings.ToUpper(format),
		rowLabel,
		formatExportBytes(size),
	)
}

func formatExportBytes(size int64) string {
	units := []string{"B", "KB", "MB", "GB", "TB"}
	value := float64(size)
	unitIndex := 0
	for value >= 1024 && unitIndex < len(units)-1 {
		value /= 1024
		unitIndex++
	}
	if unitIndex == 0 {
		return fmt.Sprintf("%d %s", size, units[unitIndex])
	}
	return fmt.Sprintf("%.1f %s", value, units[unitIndex])
}

func sourceExportFileName(requestedName, tableRef, format string) string {
	name := strings.TrimSpace(requestedName)
	if name == "" {
		parts := strings.Split(tableRef, ".")
		name = strings.Trim(strings.TrimSpace(parts[len(parts)-1]), `"`)
	}
	name = filepath.Base(name)
	lowerName := strings.ToLower(name)
	if strings.HasSuffix(lowerName, ".csv") {
		name = name[:len(name)-len(".csv")]
	} else if strings.HasSuffix(lowerName, ".parquet") {
		name = name[:len(name)-len(".parquet")]
	}
	name = strings.Map(func(character rune) rune {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9' || character == '-' || character == '_' || character == ' ' {
			return character
		}
		return '_'
	}, name)
	name = strings.TrimSpace(name)
	if name == "" {
		name = "source"
	}
	return name + "." + format
}

type localQueryResponse struct {
	ShapeID  string                 `json:"shapeId"`
	RowCount int64                  `json:"rowCount"`
	Schema   []session.ResultColumn `json:"schema"`
}

type localHTTPQueryClient struct {
	server *Server
}

func (c *localHTTPQueryClient) SendJSON(_ map[string]interface{}) error {
	return nil
}

func (c *localHTTPQueryClient) SendResultData(shapeID string, format runner.ResultFormat, data []byte, rowCount int64, transient bool) error {
	return fmt.Errorf("paginated local queries do not send complete result buffers")
}

func (c *localHTTPQueryClient) ResolveBlobURL(blobID string) (string, error) {
	if _, _, err := c.server.document.BlobPath(blobID); err != nil {
		return "", err
	}
	return c.server.baseURL + "/api/session/blobs/" + url.PathEscape(blobID), nil
}

func (s *Server) handleQuery(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<20)
	var request runner.QueryRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeAPIError(w, http.StatusBadRequest, fmt.Errorf("invalid query request"))
		return
	}
	request.SQL = strings.TrimSpace(request.SQL)
	request.ShapeId = strings.TrimSpace(request.ShapeId)
	if request.SQL == "" || request.ShapeId == "" {
		writeAPIError(w, http.StatusBadRequest, fmt.Errorf("sql and shapeId are required"))
		return
	}
	querySession, done, err := s.beginQueryOperation()
	if err != nil {
		writeAPIError(w, http.StatusServiceUnavailable, err)
		return
	}
	defer done()
	client := &localHTTPQueryClient{server: s}
	result, err := querySession.RunQuery(r.Context(), client, request)
	if err != nil {
		if r.Context().Err() != nil {
			return
		}
		writeAPIError(w, http.StatusUnprocessableEntity, err)
		return
	}
	writeJSON(w, http.StatusOK, localQueryResponse{
		ShapeID:  request.ShapeId,
		RowCount: result.RowCount,
		Schema:   result.Schema,
	})
}

func resultPageInteger(r *http.Request, name string, defaultValue int) (int, error) {
	raw := strings.TrimSpace(r.URL.Query().Get(name))
	if raw == "" {
		return defaultValue, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer", name)
	}
	return value, nil
}

func (s *Server) handleQueryResultPage(w http.ResponseWriter, r *http.Request) {
	offset, err := resultPageInteger(r, "offset", 0)
	if err != nil || offset < 0 {
		writeAPIError(w, http.StatusBadRequest, fmt.Errorf("offset must be a non-negative integer"))
		return
	}
	limit, err := resultPageInteger(r, "limit", 1000)
	if err != nil || limit < 1 || limit > 10001 {
		writeAPIError(w, http.StatusBadRequest, fmt.Errorf("limit must be between 1 and 10001"))
		return
	}
	querySession, done, err := s.beginQueryOperation()
	if err != nil {
		writeAPIError(w, http.StatusServiceUnavailable, err)
		return
	}
	defer done()
	shapeID := r.PathValue("shapeId")
	if !querySession.HasQueryResult(shapeID) {
		writeAPIError(w, http.StatusNotFound, fmt.Errorf("query result is not loaded; run the query to load it"))
		return
	}
	reader, err := querySession.QueryResultPage(r.Context(), shapeID, offset, limit)
	if err != nil {
		writeAPIError(w, http.StatusUnprocessableEntity, fmt.Errorf("read query result: %w", err))
		return
	}
	defer reader.Release()
	writeArrowResult(w, reader)
}

func writeArrowResult(w http.ResponseWriter, reader interface {
	Schema() *arrow.Schema
	Next() bool
	Record() arrow.Record
	Err() error
}) {
	w.Header().Set("Content-Type", "application/vnd.apache.arrow.stream")
	writer := ipc.NewWriter(w, ipc.WithSchema(reader.Schema()))
	for reader.Next() {
		if err := writer.Write(reader.Record()); err != nil {
			_ = writer.Close()
			return
		}
	}
	if err := reader.Err(); err != nil {
		_ = writer.Close()
		return
	}
	if err := writer.Close(); err != nil {
		log.Printf("write paginated Arrow result: %v", err)
	}
}

func (s *Server) handleCancelQuery(w http.ResponseWriter, r *http.Request) {
	shapeID := strings.TrimSpace(r.PathValue("shapeId"))
	if shapeID == "" {
		writeAPIError(w, http.StatusBadRequest, fmt.Errorf("shapeId is required"))
		return
	}
	s.queriesMu.RLock()
	s.queries.CancelQuery(shapeID)
	s.queriesMu.RUnlock()
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleDropQueryResult(w http.ResponseWriter, r *http.Request) {
	shapeID := strings.TrimSpace(r.PathValue("shapeId"))
	if shapeID == "" {
		writeAPIError(w, http.StatusBadRequest, fmt.Errorf("shapeId is required"))
		return
	}
	querySession, done, err := s.beginQueryOperation()
	if err != nil {
		writeAPIError(w, http.StatusServiceUnavailable, err)
		return
	}
	defer done()
	if err := querySession.DropResults(r.Context(), []string{shapeID}); err != nil {
		writeAPIError(w, http.StatusInternalServerError, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleDeleteBlobsForShapes(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var request struct {
		ShapeIDs []string `json:"shapeIds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeAPIError(w, http.StatusBadRequest, fmt.Errorf("invalid shape blob deletion request"))
		return
	}
	if err := s.document.DeleteBlobsForShapes(request.ShapeIDs); err != nil {
		writeAPIError(w, http.StatusInternalServerError, err)
		return
	}
	s.queriesMu.RLock()
	err := s.queries.DropResults(r.Context(), request.ShapeIDs)
	s.queriesMu.RUnlock()
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeSSEEvent(w io.Writer, event cliRuntimeEvent) error {
	data, err := json.Marshal(event.data)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event.name, data)
	return err
}

func (s *Server) handleCLIEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeAPIError(w, http.StatusInternalServerError, fmt.Errorf("streaming is unavailable"))
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")

	s.queriesMu.RLock()
	sources := s.queries.SourceList()
	s.queriesMu.RUnlock()
	if err := writeSSEEvent(w, cliRuntimeEvent{name: "snapshot", data: map[string]interface{}{
		"sources": sources,
		"output":  s.cliOutputHistory(),
	}}); err != nil {
		return
	}
	flusher.Flush()

	subscriber := make(chan cliRuntimeEvent, 64)
	s.eventMu.Lock()
	s.eventSubscribers[subscriber] = struct{}{}
	s.eventMu.Unlock()
	defer func() {
		s.eventMu.Lock()
		if _, exists := s.eventSubscribers[subscriber]; exists {
			delete(s.eventSubscribers, subscriber)
			close(subscriber)
		}
		s.eventMu.Unlock()
	}()

	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case event, open := <-subscriber:
			if !open || writeSSEEvent(w, event) != nil {
				return
			}
			flusher.Flush()
		case <-heartbeat.C:
			if _, err := io.WriteString(w, ": keepalive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}
