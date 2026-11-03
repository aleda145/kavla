package localapp

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
	"github.com/google/uuid"
)

const snapshotTimeFormat = "20060102T150405.000000000Z"
const defaultHistoryLimit = 5

var snapshotIDPattern = regexp.MustCompile(`^\d{8}T\d{6}\.\d{9}Z_(opened|automatic|save|before-restore)_[a-f0-9-]{36}$`)

type CanvasSnapshot struct {
	ID         string    `json:"id"`
	CreatedAt  time.Time `json:"createdAt"`
	Reason     string    `json:"reason"`
	Size       int64     `json:"size"`
	ShapeCount int       `json:"shapeCount"`
}

type CanvasHistory struct {
	Snapshots []CanvasSnapshot `json:"snapshots"`
	Limit     int              `json:"limit"`
}

// History stores small references to pinned, immutable archive revisions.
// Legacy standalone snapshot archives remain readable and downloadable.
func (d *Document) snapshotDirectoryLocked() (string, error) {
	configPath, err := kavlaconfig.GetConfigPath()
	if err != nil {
		return "", err
	}
	if d.manifest.DocumentID == "" {
		return "", fmt.Errorf("cannot snapshot a canvas without a document ID")
	}
	key := sha256.Sum256([]byte(d.manifest.DocumentID))
	return filepath.Join(filepath.Dir(configPath), "history", hex.EncodeToString(key[:])), nil
}

func (d *Document) ListSnapshots() (CanvasHistory, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	snapshots, err := d.listSnapshotsLocked()
	if err != nil {
		return CanvasHistory{}, err
	}
	limit, err := d.historyLimitLocked()
	if err != nil {
		return CanvasHistory{}, err
	}
	directory, err := d.snapshotDirectoryLocked()
	if err != nil {
		return CanvasHistory{}, err
	}
	// Read shape counts from each archive's canvas records.
	// Automatic snapshot deduplication only uses the cheaper directory listing.
	for i := range snapshots {
		_, canvas, err := snapshotArchiveState(snapshotFilePath(directory, snapshots[i].ID))
		if err != nil {
			return CanvasHistory{}, fmt.Errorf("read snapshot shape count: %w", err)
		}
		shapes, _, err := canvasBlobOwners(canvas)
		if err != nil {
			return CanvasHistory{}, fmt.Errorf("read snapshot %s shape count: %w", snapshots[i].ID, err)
		}
		snapshots[i].ShapeCount = len(shapes)
	}
	return CanvasHistory{Snapshots: snapshots, Limit: limit}, nil
}

func (d *Document) listSnapshotsLocked() ([]CanvasSnapshot, error) {
	directory, err := d.snapshotDirectoryLocked()
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(directory)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("read canvas history: %w", err)
	}
	snapshots := make([]CanvasSnapshot, 0, len(entries))
	for _, entry := range entries {
		ext := filepath.Ext(entry.Name())
		id := strings.TrimSuffix(entry.Name(), ext)
		if entry.IsDir() || (ext != ".kavla" && ext != ".revision") || !snapshotIDPattern.MatchString(id) {
			continue
		}
		parts := strings.SplitN(id, "_", 3)
		createdAt, err := time.Parse(snapshotTimeFormat, parts[0])
		if err != nil {
			return nil, fmt.Errorf("read snapshot timestamp: %w", err)
		}
		info, err := entry.Info()
		if err != nil {
			return nil, err
		}
		size := info.Size()
		ref, err := readHistoryReference(filepath.Join(directory, entry.Name()))
		if err != nil {
			return nil, err
		}
		if ref != nil {
			size = ref.Size
		}
		snapshots = append(snapshots, CanvasSnapshot{ID: id, CreatedAt: createdAt, Reason: parts[1], Size: size})
	}
	sort.Slice(snapshots, func(i, j int) bool { return snapshots[i].ID > snapshots[j].ID })
	return snapshots, nil
}

func (d *Document) snapshotPathLocked(id string) (string, error) {
	if !snapshotIDPattern.MatchString(id) {
		return "", fmt.Errorf("invalid snapshot ID")
	}
	directory, err := d.snapshotDirectoryLocked()
	if err != nil {
		return "", err
	}
	return snapshotFilePath(directory, id), nil
}

func snapshotFilePath(directory, id string) string {
	path := filepath.Join(directory, id+".revision")
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return filepath.Join(directory, id+".kavla")
	}
	return path
}

// Only read the small document entries, never the uploaded file contents.
func snapshotArchiveState(path string) (Manifest, []byte, error) {
	reader, entries, err := openArchiveEntries(path)
	if err != nil {
		return Manifest{}, nil, err
	}
	defer reader.Close()
	data, err := readZipEntry(entries["manifest.json"], 8<<20)
	if err != nil {
		return Manifest{}, nil, err
	}
	var manifest Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return Manifest{}, nil, err
	}
	canvas, err := readZipEntry(entries["canvas.json"], 256<<20)
	return manifest, canvas, err
}

func (d *Document) ReadSnapshot(id string) ([]byte, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	path, err := d.snapshotPathLocked(id)
	if err != nil {
		return nil, err
	}
	_, canvas, err := snapshotArchiveState(path)
	return canvas, err
}

func (d *Document) Snapshot(reason string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.canvasJSON) == 0 {
		return nil
	}
	if reason == "opened" {
		if err := d.keepArchiveSnapshotLocked(d.path, reason); err != nil {
			return err
		}
		return d.pruneSnapshotsLocked()
	}
	if reason != "automatic" && reason != "before-restore" {
		return fmt.Errorf("invalid snapshot reason")
	}
	if reason == "automatic" {
		if _, err := os.Stat(d.path); err == nil {
			manifest, canvas, err := snapshotArchiveState(d.path)
			if err != nil {
				return err
			}
			if bytes.Equal(canvas, d.canvasJSON) && manifest.DocumentName == d.manifest.DocumentName &&
				manifest.FormatVersion == d.manifest.FormatVersion && slices.Equal(manifest.Blobs, d.manifest.Blobs) {
				// Avoid rebuilding large unchanged archives on the periodic timer.
				if err := d.keepArchiveSnapshotLocked(d.path, reason); err != nil {
					return err
				}
				return d.pruneSnapshotsLocked()
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return d.writeArchiveWithHistoryLocked(d.path, true, reason)
}

func (d *Document) SnapshotBeforeRestore() (string, error) {
	return d.snapshotBeforeRestore(true)
}

func (d *Document) snapshotBeforeRestore(prune bool) (string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.canvasJSON) == 0 {
		return "", fmt.Errorf("cannot restore without canvas state")
	}
	if err := d.writeArchiveWithHistoryLocked(d.path, true, "restore"); err != nil {
		return "", err
	}
	directory, err := d.snapshotDirectoryLocked()
	if err != nil {
		return "", err
	}
	if _, err := d.historyLimitLocked(); err != nil {
		return "", err
	}
	id := time.Now().UTC().Format(snapshotTimeFormat) + "_before-restore_" + uuid.NewString()
	if err := d.pinArchiveSnapshot(d.path, filepath.Join(directory, id+".revision")); err != nil {
		return "", err
	}
	if prune {
		if err := d.pruneSnapshotsLocked(); err != nil {
			return "", err
		}
	}
	return id, nil
}

func (d *Document) keepArchiveSnapshotLocked(archivePath, reason string) error {
	directory, err := d.snapshotDirectoryLocked()
	if err != nil {
		return err
	}
	if _, err := d.historyLimitLocked(); err != nil {
		return err
	}
	snapshots, err := d.listSnapshotsLocked()
	if err != nil {
		return err
	}
	if len(snapshots) > 0 {
		previousManifest, previousCanvas, err := snapshotArchiveState(snapshotFilePath(directory, snapshots[0].ID))
		if err != nil {
			return err
		}
		manifest, canvas, err := snapshotArchiveState(archivePath)
		if err != nil {
			return err
		}
		// Ignore save timestamps, but include uploads even when no shapes changed.
		if bytes.Equal(previousCanvas, canvas) && manifest.DocumentName == previousManifest.DocumentName &&
			manifest.FormatVersion == previousManifest.FormatVersion && slices.Equal(manifest.Blobs, previousManifest.Blobs) {
			return nil
		}
	}
	id := time.Now().UTC().Format(snapshotTimeFormat) + "_" + reason + "_" + uuid.NewString()
	return d.pinArchiveSnapshot(archivePath, filepath.Join(directory, id+".revision"))
}

// Stream large archives to a separate file. Linking to the live document would
// allow external in-place edits to change history too.
func atomicCopyArchive(sourcePath, destinationPath string) error {
	source, err := os.Open(sourcePath)
	if err != nil {
		return err
	}
	defer source.Close()
	if err := os.MkdirAll(filepath.Dir(destinationPath), 0700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(destinationPath), ".history-*")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	_, copyErr := io.Copy(temp, source)
	if copyErr == nil {
		copyErr = temp.Sync()
	}
	if err := temp.Close(); copyErr == nil {
		copyErr = err
	}
	if copyErr != nil {
		return fmt.Errorf("copy history archive: %w", copyErr)
	}
	return os.Rename(temp.Name(), destinationPath)
}

func (d *Document) historyLimitLocked() (int, error) {
	directory, err := d.snapshotDirectoryLocked()
	if err != nil {
		return 0, err
	}
	data, err := os.ReadFile(filepath.Join(directory, "settings.json"))
	if errors.Is(err, os.ErrNotExist) {
		return defaultHistoryLimit, nil
	}
	if err != nil {
		return 0, err
	}
	var settings struct {
		Limit int `json:"limit"`
	}
	if err := json.Unmarshal(data, &settings); err != nil {
		return 0, err
	}
	if settings.Limit < 1 {
		return 0, fmt.Errorf("history limit must be at least 1")
	}
	return settings.Limit, nil
}

func (d *Document) SetHistoryLimit(limit int) error {
	if limit < 1 {
		return fmt.Errorf("history limit must be at least 1")
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	directory, err := d.snapshotDirectoryLocked()
	if err != nil {
		return err
	}
	data, err := json.Marshal(struct {
		Limit int `json:"limit"`
	}{Limit: limit})
	if err != nil {
		return err
	}
	if err := atomicWriteFile(filepath.Join(directory, "settings.json"), data, 0600); err != nil {
		return err
	}
	return d.pruneSnapshotsLocked()
}

func (d *Document) pruneSnapshotsLocked() error {
	limit, err := d.historyLimitLocked()
	if err != nil {
		return err
	}
	snapshots, err := d.listSnapshotsLocked()
	if err != nil {
		return err
	}
	directory, err := d.snapshotDirectoryLocked()
	if err != nil {
		return err
	}
	candidates := make(map[string]bool)
	for i := limit; i < len(snapshots); i++ {
		ref, err := readHistoryReference(snapshotFilePath(directory, snapshots[i].ID))
		if err != nil {
			return err
		}
		if ref != nil {
			candidates[ref.Path] = true
		}
		if err := os.Remove(snapshotFilePath(directory, snapshots[i].ID)); err != nil {
			return fmt.Errorf("remove expired history entry: %w", err)
		}
	}
	return removeUnusedHistoryPins(directory, candidates)
}

func (s *Server) handleListSnapshots(w http.ResponseWriter, _ *http.Request) {
	history, err := s.document.ListSnapshots()
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, history)
}

func (s *Server) handleHistoryLimit(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	var request struct {
		Limit int `json:"limit"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil || request.Limit < 1 {
		writeAPIError(w, http.StatusBadRequest, fmt.Errorf("enter a whole number of saves, at least 1"))
		return
	}
	if err := s.document.SetHistoryLimit(request.Limit); err != nil {
		writeAPIError(w, http.StatusInternalServerError, err)
		return
	}
	s.handleListSnapshots(w, r)
}

func (s *Server) handleReadSnapshot(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !snapshotIDPattern.MatchString(id) {
		writeAPIError(w, http.StatusBadRequest, fmt.Errorf("invalid snapshot ID"))
		return
	}
	canvas, err := s.document.ReadSnapshot(id)
	if err != nil {
		writeSnapshotError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if _, err := w.Write(canvas); err != nil {
		s.logCLIOutput("Could not send canvas snapshot: %v\n", err)
	}
}

func writeSnapshotError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	if errors.Is(err, os.ErrNotExist) {
		status = http.StatusNotFound
	}
	writeAPIError(w, status, err)
}

func (s *Server) handleDownloadSnapshot(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !snapshotIDPattern.MatchString(id) {
		writeAPIError(w, http.StatusBadRequest, fmt.Errorf("invalid snapshot ID"))
		return
	}
	s.document.mu.RLock()
	path, err := s.document.snapshotPathLocked(id)
	var file *documentArchive
	var content io.ReadSeeker
	if err == nil {
		file, content, err = snapshotContent(path)
	}
	name := s.document.manifest.DocumentName + "-" + id + ".kavla"
	s.document.mu.RUnlock()
	if err != nil {
		writeSnapshotError(w, err)
		return
	}
	defer file.Close()
	info, err := file.file.Stat()
	if err != nil {
		writeSnapshotError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	http.ServeContent(w, r, name, info.ModTime(), content)
}

func (s *Server) handleCreateSnapshot(w http.ResponseWriter, r *http.Request) {
	reason := r.URL.Query().Get("reason")
	if reason != "automatic" && reason != "before-restore" {
		writeAPIError(w, http.StatusBadRequest, fmt.Errorf("invalid snapshot reason"))
		return
	}
	if err := s.document.Snapshot(reason); err != nil {
		writeAPIError(w, http.StatusInternalServerError, err)
		return
	}
	s.writeSavedDocumentResponse(w)
}

func (s *Server) handleRestoreSnapshot(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !snapshotIDPattern.MatchString(id) {
		writeAPIError(w, http.StatusBadRequest, fmt.Errorf("invalid snapshot ID"))
		return
	}
	d := s.document
	d.mu.RLock()
	path, err := d.snapshotPathLocked(id)
	d.mu.RUnlock()
	if err != nil {
		writeSnapshotError(w, err)
		return
	}
	// Opening a missing document normally creates an empty one. History restores
	// must instead fail when the requested archive has been pruned.
	if _, err := os.Stat(path); err != nil {
		writeSnapshotError(w, err)
		return
	}
	next, err := openDocument(path, false)
	if err != nil {
		writeSnapshotError(w, err)
		return
	}
	defer next.CleanupWorkingCopy()
	// Materialize before the pre-restore save can prune this entry.
	// The target now stays pinned until publication instead of extracting data.
	beforeRestoreID, err := d.snapshotBeforeRestore(false)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, err)
		return
	}
	defer func() {
		d.mu.Lock()
		defer d.mu.Unlock()
		if err := d.pruneSnapshotsLocked(); err != nil {
			log.Printf("Trim history after restore: %v", err)
		}
	}()
	current := d.Manifest()
	next.path = d.Path()
	next.manifest.DocumentID = current.DocumentID
	next.manifest.DocumentName = current.DocumentName
	s.closeAgent()
	defer s.startAgentDetection()
	if err := s.switchDocumentBeforePublish(r.Context(), next, next.SaveRestored); err != nil {
		writeAPIError(w, http.StatusInternalServerError, err)
		return
	}
	if err := s.loadAgentRuns(); err != nil {
		log.Printf("Load agent runs after history restore: %v", err)
	}
	s.publishAgentRuns(false)
	s.writeSession(w, beforeRestoreID)
}
