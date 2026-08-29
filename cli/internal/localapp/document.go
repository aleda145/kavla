package localapp

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

const FormatVersion = 1

var blobIDPattern = regexp.MustCompile(`^[A-Za-z0-9:_-]{1,200}$`)
var sha256Pattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type BlobKind string

const (
	BlobKindSource BlobKind = "source"
	BlobKindAsset  BlobKind = "asset"
)

type BlobDescriptor struct {
	ID       string   `json:"id"`
	Kind     BlobKind `json:"kind"`
	ShapeID  string   `json:"shapeId,omitempty"`
	FileName string   `json:"fileName"`
	MIMEType string   `json:"mimeType"`
	Size     int64    `json:"size"`
	SHA256   string   `json:"sha256"`
}

type Manifest struct {
	FormatVersion int              `json:"formatVersion"`
	DocumentID    string           `json:"documentId"`
	DocumentName  string           `json:"documentName"`
	CreatedAt     time.Time        `json:"createdAt"`
	UpdatedAt     time.Time        `json:"updatedAt"`
	Blobs         []BlobDescriptor `json:"blobs"`
}

type Document struct {
	mu         sync.RWMutex
	path       string
	workingDir string
	manifest   Manifest
	canvasJSON []byte
	blobs      map[string]BlobDescriptor
}

func OpenDocument(path string) (*Document, error) {
	absPath, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve document path: %w", err)
	}
	if !strings.EqualFold(filepath.Ext(absPath), ".kavla") {
		return nil, fmt.Errorf("Kavla documents must use the .kavla extension")
	}

	workingDir, err := createWorkingDirectory()
	if err != nil {
		return nil, err
	}
	document := &Document{path: absPath, workingDir: workingDir, blobs: make(map[string]BlobDescriptor)}
	opened := false
	defer func() {
		if !opened {
			_ = os.RemoveAll(workingDir)
		}
	}()

	if _, err := os.Stat(absPath); err == nil {
		if err := document.loadArchive(); err != nil {
			return nil, err
		}
		if err := document.initializeWorkingCopy(); err != nil {
			return nil, err
		}
		opened = true
		return document, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("inspect document: %w", err)
	}

	now := time.Now().UTC()
	document.manifest = Manifest{
		FormatVersion: FormatVersion,
		DocumentID:    uuid.NewString(),
		DocumentName:  strings.TrimSuffix(filepath.Base(absPath), filepath.Ext(absPath)),
		CreatedAt:     now,
		UpdatedAt:     now,
		Blobs:         []BlobDescriptor{},
	}
	if err := document.initializeWorkingCopy(); err != nil {
		return nil, err
	}
	opened = true
	return document, nil
}

func createWorkingDirectory() (string, error) {
	directory, err := os.MkdirTemp("", "kavla-document-*")
	if err != nil {
		return "", fmt.Errorf("create temporary Kavla working directory: %w", err)
	}
	if err := os.Chmod(directory, 0700); err != nil {
		_ = os.RemoveAll(directory)
		return "", fmt.Errorf("secure temporary Kavla working directory: %w", err)
	}
	return directory, nil
}

func (d *Document) Path() string {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.path
}

func (d *Document) Manifest() Manifest {
	d.mu.RLock()
	defer d.mu.RUnlock()
	manifest := d.manifest
	manifest.Blobs = make([]BlobDescriptor, len(d.manifest.Blobs))
	copy(manifest.Blobs, d.manifest.Blobs)
	return manifest
}

func (d *Document) CanvasJSON() []byte {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return append([]byte(nil), d.canvasJSON...)
}

func (d *Document) StageCanvas(canvasJSON []byte) error {
	if !json.Valid(canvasJSON) {
		return fmt.Errorf("canvas document is not valid JSON")
	}
	if _, _, err := canvasBlobOwners(canvasJSON); err != nil {
		return err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.canvasJSON = append(d.canvasJSON[:0], canvasJSON...)
	d.manifest.UpdatedAt = time.Now().UTC()
	if err := atomicWriteFile(filepath.Join(d.workingDir, "canvas.json"), d.canvasJSON, 0600); err != nil {
		return err
	}
	return d.writeManifestLocked()
}

func (d *Document) PutBlob(id string, descriptor BlobDescriptor, reader io.Reader) (BlobDescriptor, error) {
	if !blobIDPattern.MatchString(id) {
		return BlobDescriptor{}, fmt.Errorf("invalid blob id")
	}
	if descriptor.Kind != BlobKindSource && descriptor.Kind != BlobKindAsset {
		return BlobDescriptor{}, fmt.Errorf("invalid blob kind %q", descriptor.Kind)
	}
	if strings.TrimSpace(descriptor.FileName) == "" {
		return BlobDescriptor{}, fmt.Errorf("blob filename is required")
	}
	descriptor.ID = id
	descriptor.FileName = filepath.Base(descriptor.FileName)
	if strings.ContainsAny(descriptor.FileName, "\r\n\x00") {
		return BlobDescriptor{}, fmt.Errorf("blob filename contains invalid characters")
	}
	if descriptor.MIMEType == "" {
		descriptor.MIMEType = "application/octet-stream"
	}

	d.mu.Lock()
	defer d.mu.Unlock()
	blobDir := filepath.Join(d.workingDir, "blobs")
	if err := os.MkdirAll(blobDir, 0700); err != nil {
		return BlobDescriptor{}, fmt.Errorf("create working blob directory: %w", err)
	}
	tempFile, err := os.CreateTemp(blobDir, ".blob-*")
	if err != nil {
		return BlobDescriptor{}, fmt.Errorf("create staged blob: %w", err)
	}
	tempName := tempFile.Name()
	defer os.Remove(tempName)

	hash := sha256.New()
	size, copyErr := io.Copy(io.MultiWriter(tempFile, hash), reader)
	closeErr := tempFile.Close()
	if copyErr != nil {
		return BlobDescriptor{}, fmt.Errorf("stage blob: %w", copyErr)
	}
	if closeErr != nil {
		return BlobDescriptor{}, fmt.Errorf("close staged blob: %w", closeErr)
	}
	descriptor.Size = size
	descriptor.SHA256 = hex.EncodeToString(hash.Sum(nil))

	destination := filepath.Join(blobDir, id)
	if err := os.Rename(tempName, destination); err != nil {
		return BlobDescriptor{}, fmt.Errorf("publish staged blob: %w", err)
	}
	if err := os.Chmod(destination, 0600); err != nil {
		return BlobDescriptor{}, fmt.Errorf("secure staged blob: %w", err)
	}

	d.blobs[id] = descriptor
	d.rebuildBlobListLocked()
	d.manifest.UpdatedAt = time.Now().UTC()
	if err := d.writeManifestLocked(); err != nil {
		return BlobDescriptor{}, err
	}
	return descriptor, nil
}

func (d *Document) DeleteBlobsForShapes(shapeIDs []string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	shapes := make(map[string]struct{}, len(shapeIDs))
	for _, shapeID := range shapeIDs {
		shapes[shapeID] = struct{}{}
	}
	removed := make(map[string]BlobDescriptor)
	for id, descriptor := range d.blobs {
		if _, ok := shapes[descriptor.ShapeID]; !ok {
			continue
		}
		removed[id] = descriptor
		delete(d.blobs, id)
	}
	if len(removed) == 0 {
		return nil
	}
	d.rebuildBlobListLocked()
	d.manifest.UpdatedAt = time.Now().UTC()
	if err := d.writeManifestLocked(); err != nil {
		for id, descriptor := range removed {
			d.blobs[id] = descriptor
		}
		d.rebuildBlobListLocked()
		return err
	}
	for id := range removed {
		if err := os.Remove(filepath.Join(d.workingDir, "blobs", id)); err != nil && !errors.Is(err, os.ErrNotExist) {
			log.Printf("Kavla could not remove unreferenced blob %s: %v", id, err)
		}
	}
	return nil
}

func (d *Document) DeleteBlob(id string) error {
	if !blobIDPattern.MatchString(id) {
		return os.ErrNotExist
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	descriptor, ok := d.blobs[id]
	if !ok {
		return os.ErrNotExist
	}
	delete(d.blobs, id)
	d.rebuildBlobListLocked()
	d.manifest.UpdatedAt = time.Now().UTC()
	if err := d.writeManifestLocked(); err != nil {
		d.blobs[id] = descriptor
		d.rebuildBlobListLocked()
		return err
	}
	if err := os.Remove(filepath.Join(d.workingDir, "blobs", id)); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("Kavla could not remove unreferenced blob %s: %v", id, err)
	}
	return nil
}

func (d *Document) BlobPath(id string) (string, BlobDescriptor, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	descriptor, ok := d.blobs[id]
	if !ok {
		return "", BlobDescriptor{}, os.ErrNotExist
	}
	blobPath := filepath.Join(d.workingDir, "blobs", id)
	if err := d.ensureBlobExtractedLocked(id, descriptor); err != nil {
		return "", BlobDescriptor{}, err
	}
	return blobPath, descriptor, nil
}

func (d *Document) Save() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.saveLocked(d.path)
}

func (d *Document) SaveAs(path string) error {
	if !filepath.IsAbs(path) {
		return fmt.Errorf("save path must be absolute")
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("resolve save path: %w", err)
	}
	if !strings.EqualFold(filepath.Ext(absPath), ".kavla") {
		return fmt.Errorf("Kavla documents must use the .kavla extension")
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	previousName := d.manifest.DocumentName
	d.manifest.DocumentName = strings.TrimSuffix(filepath.Base(absPath), filepath.Ext(absPath))
	if err := d.saveLocked(absPath); err != nil {
		d.manifest.DocumentName = previousName
		_ = d.writeManifestLocked()
		return err
	}

	d.path = absPath
	return nil
}

func (d *Document) OpenFromPath(path string) error {
	if !filepath.IsAbs(path) {
		return fmt.Errorf("document path must be absolute")
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("resolve document path: %w", err)
	}
	if err := d.ReplaceFromArchive(absPath); err != nil {
		return err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.path = absPath
	return nil
}

func (d *Document) NewAtPath(path string, canvasJSON []byte, overwrite bool) error {
	if !filepath.IsAbs(path) {
		return fmt.Errorf("document path must be absolute")
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("resolve document path: %w", err)
	}
	if !strings.EqualFold(filepath.Ext(absPath), ".kavla") {
		return fmt.Errorf("Kavla documents must use the .kavla extension")
	}
	if !json.Valid(canvasJSON) {
		return fmt.Errorf("new canvas document is not valid JSON")
	}
	newWorkingDir, err := createWorkingDirectory()
	if err != nil {
		return err
	}
	stagedWorkingDir := newWorkingDir
	defer func() {
		if stagedWorkingDir != "" {
			_ = os.RemoveAll(stagedWorkingDir)
		}
	}()
	if err := os.MkdirAll(filepath.Join(stagedWorkingDir, "blobs"), 0700); err != nil {
		return fmt.Errorf("create new blob directory: %w", err)
	}
	now := time.Now().UTC()
	manifest := Manifest{
		FormatVersion: FormatVersion,
		DocumentID:    uuid.NewString(),
		DocumentName:  strings.TrimSuffix(filepath.Base(absPath), filepath.Ext(absPath)),
		CreatedAt:     now,
		UpdatedAt:     now,
		Blobs:         []BlobDescriptor{},
	}
	manifestJSON, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return fmt.Errorf("encode new manifest: %w", err)
	}
	if err := atomicWriteFile(filepath.Join(stagedWorkingDir, "manifest.json"), manifestJSON, 0600); err != nil {
		return fmt.Errorf("stage new manifest: %w", err)
	}
	if err := atomicWriteFile(filepath.Join(stagedWorkingDir, "canvas.json"), canvasJSON, 0600); err != nil {
		return fmt.Errorf("stage new canvas: %w", err)
	}

	stagedDocument := &Document{
		path:       absPath,
		workingDir: newWorkingDir,
		manifest:   manifest,
		canvasJSON: append([]byte(nil), canvasJSON...),
		blobs:      make(map[string]BlobDescriptor),
	}
	var saveErr error
	if overwrite {
		saveErr = stagedDocument.saveLocked(absPath)
	} else {
		saveErr = stagedDocument.saveNewLocked(absPath)
	}
	if saveErr != nil {
		return saveErr
	}

	d.mu.Lock()
	oldWorkingDir := d.workingDir
	d.path = absPath
	d.workingDir = newWorkingDir
	d.manifest = stagedDocument.manifest
	d.canvasJSON = append([]byte(nil), canvasJSON...)
	d.blobs = make(map[string]BlobDescriptor)
	d.mu.Unlock()
	if oldWorkingDir != newWorkingDir {
		_ = os.RemoveAll(oldWorkingDir)
	}
	stagedWorkingDir = ""
	return nil
}

func (d *Document) saveLocked(path string) error {
	return d.writeArchiveLocked(path, true)
}

func (d *Document) saveNewLocked(path string) error {
	return d.writeArchiveLocked(path, false)
}

func (d *Document) writeArchiveLocked(path string, replace bool) error {
	if len(d.canvasJSON) == 0 {
		return fmt.Errorf("cannot save a Kavla document without canvas state")
	}
	if err := d.pruneUnreferencedBlobsLocked(); err != nil {
		return err
	}
	d.manifest.UpdatedAt = time.Now().UTC()
	d.rebuildBlobListLocked()
	if err := d.writeManifestLocked(); err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return fmt.Errorf("create document directory: %w", err)
	}
	tempFile, err := os.CreateTemp(filepath.Dir(path), ".kavla-save-*")
	if err != nil {
		return fmt.Errorf("create temporary Kavla file: %w", err)
	}
	tempName := tempFile.Name()
	defer os.Remove(tempName)

	zipWriter := zip.NewWriter(tempFile)
	manifestJSON, err := json.MarshalIndent(d.manifest, "", "  ")
	if err == nil {
		err = writeZipBytes(zipWriter, "manifest.json", manifestJSON, zip.Deflate)
	}
	if err == nil {
		err = writeZipBytes(zipWriter, "canvas.json", d.canvasJSON, zip.Deflate)
	}
	if err == nil {
		for _, descriptor := range d.manifest.Blobs {
			if err = d.ensureBlobExtractedLocked(descriptor.ID, descriptor); err != nil {
				break
			}
			if err = writeZipFile(zipWriter, "blobs/"+descriptor.ID, filepath.Join(d.workingDir, "blobs", descriptor.ID)); err != nil {
				break
			}
		}
	}
	if closeErr := zipWriter.Close(); err == nil {
		err = closeErr
	}
	if syncErr := tempFile.Sync(); err == nil {
		err = syncErr
	}
	if closeErr := tempFile.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return fmt.Errorf("write Kavla archive: %w", err)
	}
	if err := os.Chmod(tempName, 0600); err != nil {
		return fmt.Errorf("secure Kavla archive: %w", err)
	}
	if replace {
		if err := os.Rename(tempName, path); err != nil {
			return fmt.Errorf("replace Kavla archive: %w", err)
		}
		return nil
	}
	if err := os.Link(tempName, path); err != nil {
		return fmt.Errorf("create Kavla archive without overwrite: %w", err)
	}
	return nil
}

// ReplaceFromArchive validates and stages another Kavla archive before replacing
// the active working copy. The active document path is intentionally kept:
// loading is an import into the document that the CLI was started with.
func (d *Document) ReplaceFromArchive(archivePath string) error {
	imported, err := OpenDocument(archivePath)
	if err != nil {
		return fmt.Errorf("open loaded Kavla document: %w", err)
	}
	defer imported.CleanupWorkingCopy()

	manifest := imported.Manifest()
	canvasJSON := imported.CanvasJSON()
	if len(canvasJSON) == 0 {
		return fmt.Errorf("loaded Kavla document has no canvas state")
	}

	stagedWorkingDir, err := createWorkingDirectory()
	if err != nil {
		return fmt.Errorf("create loaded working copy: %w", err)
	}
	defer func() {
		if stagedWorkingDir != "" {
			_ = os.RemoveAll(stagedWorkingDir)
		}
	}()
	stagedBlobDir := filepath.Join(stagedWorkingDir, "blobs")
	if err := os.MkdirAll(stagedBlobDir, 0700); err != nil {
		return fmt.Errorf("create loaded blob directory: %w", err)
	}
	if err := atomicWriteFile(filepath.Join(stagedWorkingDir, "canvas.json"), canvasJSON, 0600); err != nil {
		return fmt.Errorf("stage loaded canvas: %w", err)
	}
	manifestJSON, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return fmt.Errorf("encode loaded manifest: %w", err)
	}
	if err := atomicWriteFile(filepath.Join(stagedWorkingDir, "manifest.json"), manifestJSON, 0600); err != nil {
		return fmt.Errorf("stage loaded manifest: %w", err)
	}

	nextBlobs := make(map[string]BlobDescriptor, len(manifest.Blobs))
	for _, descriptor := range manifest.Blobs {
		sourcePath, _, err := imported.BlobPath(descriptor.ID)
		if err != nil {
			return fmt.Errorf("read loaded blob %s: %w", descriptor.ID, err)
		}
		if err := copyPrivateFile(sourcePath, filepath.Join(stagedBlobDir, descriptor.ID)); err != nil {
			return fmt.Errorf("stage loaded blob %s: %w", descriptor.ID, err)
		}
		nextBlobs[descriptor.ID] = descriptor
	}

	d.mu.Lock()
	defer d.mu.Unlock()
	oldWorkingDir := d.workingDir
	d.workingDir = stagedWorkingDir
	d.manifest = manifest
	d.canvasJSON = append(d.canvasJSON[:0], canvasJSON...)
	d.blobs = nextBlobs
	stagedWorkingDir = ""
	_ = os.RemoveAll(oldWorkingDir)
	return nil
}

// CleanupWorkingCopy removes the process-local extracted document state. A
// working copy is never considered on the next launch; only a saved .kavla
// archive is opened.
func (d *Document) CleanupWorkingCopy() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.workingDir == "" {
		return nil
	}
	if err := os.RemoveAll(d.workingDir); err != nil {
		return fmt.Errorf("remove temporary Kavla working copy: %w", err)
	}
	d.workingDir = ""
	return nil
}

func (d *Document) loadArchive() error {
	reader, entries, err := openArchiveEntries(d.path)
	if err != nil {
		return fmt.Errorf("open Kavla archive: %w", err)
	}
	defer reader.Close()
	if err := os.MkdirAll(filepath.Join(d.workingDir, "blobs"), 0700); err != nil {
		return err
	}

	var manifestJSON []byte
	var canvasJSON []byte
	if manifestJSON, err = readZipEntry(entries["manifest.json"], 8<<20); err != nil {
		return fmt.Errorf("read manifest: %w", err)
	}
	if err := json.Unmarshal(manifestJSON, &d.manifest); err != nil {
		return fmt.Errorf("parse manifest: %w", err)
	}
	if d.manifest.FormatVersion != FormatVersion {
		return fmt.Errorf("unsupported .kavla format version %d", d.manifest.FormatVersion)
	}
	if canvasJSON, err = readZipEntry(entries["canvas.json"], 256<<20); err != nil {
		return fmt.Errorf("read canvas: %w", err)
	}
	if !json.Valid(canvasJSON) {
		return fmt.Errorf("canvas.json is not valid JSON")
	}
	d.canvasJSON = canvasJSON
	seenBlobIDs := make(map[string]struct{}, len(d.manifest.Blobs))
	for _, descriptor := range d.manifest.Blobs {
		if !blobIDPattern.MatchString(descriptor.ID) {
			return fmt.Errorf("manifest contains invalid blob id")
		}
		if descriptor.Size < 0 || !sha256Pattern.MatchString(descriptor.SHA256) {
			return fmt.Errorf("manifest contains invalid metadata for blob %s", descriptor.ID)
		}
		if strings.ContainsAny(descriptor.FileName, "\r\n\x00") || filepath.Base(descriptor.FileName) != descriptor.FileName {
			return fmt.Errorf("manifest contains invalid filename for blob %s", descriptor.ID)
		}
		if _, duplicate := seenBlobIDs[descriptor.ID]; duplicate {
			return fmt.Errorf("manifest contains duplicate blob id %s", descriptor.ID)
		}
		seenBlobIDs[descriptor.ID] = struct{}{}
		entry := entries["blobs/"+descriptor.ID]
		if entry == nil {
			return fmt.Errorf("archive is missing blob %s", descriptor.ID)
		}
		if err := validateBlobEntry(entry, descriptor); err != nil {
			return err
		}
		d.blobs[descriptor.ID] = descriptor
	}
	return nil
}

func (d *Document) initializeWorkingCopy() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := os.MkdirAll(filepath.Join(d.workingDir, "blobs"), 0700); err != nil {
		return fmt.Errorf("create Kavla working directory: %w", err)
	}
	if len(d.canvasJSON) > 0 {
		if err := atomicWriteFile(filepath.Join(d.workingDir, "canvas.json"), d.canvasJSON, 0600); err != nil {
			return err
		}
	}
	return d.writeManifestLocked()
}

func (d *Document) writeManifestLocked() error {
	data, err := json.MarshalIndent(d.manifest, "", "  ")
	if err != nil {
		return fmt.Errorf("encode working manifest: %w", err)
	}
	return atomicWriteFile(filepath.Join(d.workingDir, "manifest.json"), data, 0600)
}

func (d *Document) rebuildBlobListLocked() {
	d.manifest.Blobs = d.manifest.Blobs[:0]
	for _, descriptor := range d.blobs {
		d.manifest.Blobs = append(d.manifest.Blobs, descriptor)
	}
	sort.Slice(d.manifest.Blobs, func(i, j int) bool { return d.manifest.Blobs[i].ID < d.manifest.Blobs[j].ID })
}

func (d *Document) pruneUnreferencedBlobsLocked() error {
	shapeIDs, assetIDs, err := canvasBlobOwners(d.canvasJSON)
	if err != nil {
		return err
	}

	removed := make(map[string]BlobDescriptor)
	for id, descriptor := range d.blobs {
		if descriptor.Kind != BlobKindSource && descriptor.Kind != BlobKindAsset {
			removed[id] = descriptor
			delete(d.blobs, id)
			continue
		}
		owners := shapeIDs
		if descriptor.Kind == BlobKindAsset {
			owners = assetIDs
		}
		if _, live := owners[descriptor.ShapeID]; live {
			continue
		}
		removed[id] = descriptor
		delete(d.blobs, id)
	}
	d.rebuildBlobListLocked()
	if len(removed) == 0 {
		return nil
	}
	d.manifest.UpdatedAt = time.Now().UTC()
	if err := d.writeManifestLocked(); err != nil {
		for id, descriptor := range removed {
			d.blobs[id] = descriptor
		}
		d.rebuildBlobListLocked()
		return err
	}
	for id := range removed {
		if err := os.Remove(filepath.Join(d.workingDir, "blobs", id)); err != nil && !errors.Is(err, os.ErrNotExist) {
			log.Printf("Kavla could not remove unreferenced blob %s: %v", id, err)
		}
	}
	return nil
}

func canvasBlobOwners(canvasJSON []byte) (map[string]struct{}, map[string]struct{}, error) {
	var canvas struct {
		Records json.RawMessage `json:"records"`
	}
	if err := json.Unmarshal(canvasJSON, &canvas); err != nil {
		return nil, nil, fmt.Errorf("parse canvas for blob pruning: %w", err)
	}
	recordsJSON := strings.TrimSpace(string(canvas.Records))
	if recordsJSON == "" || recordsJSON == "null" {
		return nil, nil, fmt.Errorf("canvas document does not contain a records array")
	}
	var records []struct {
		ID       string `json:"id"`
		TypeName string `json:"typeName"`
	}
	if err := json.Unmarshal(canvas.Records, &records); err != nil {
		return nil, nil, fmt.Errorf("parse canvas records for blob pruning: %w", err)
	}

	shapeIDs := make(map[string]struct{})
	assetIDs := make(map[string]struct{})
	for _, record := range records {
		switch record.TypeName {
		case "shape":
			shapeIDs[record.ID] = struct{}{}
		case "asset":
			assetIDs[record.ID] = struct{}{}
		}
	}

	return shapeIDs, assetIDs, nil
}

func atomicWriteFile(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".write-*")
	if err != nil {
		return err
	}
	name := temp.Name()
	defer os.Remove(name)
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(name, mode); err != nil {
		return err
	}
	return os.Rename(name, path)
}

func copyPrivateFile(sourcePath, destinationPath string) error {
	source, err := os.Open(sourcePath)
	if err != nil {
		return err
	}
	defer source.Close()
	destination, err := os.OpenFile(destinationPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(destination, source); err != nil {
		destination.Close()
		return err
	}
	if err := destination.Sync(); err != nil {
		destination.Close()
		return err
	}
	return destination.Close()
}

func writeZipBytes(writer *zip.Writer, name string, data []byte, method uint16) error {
	header := &zip.FileHeader{Name: name, Method: method}
	header.SetMode(0600)
	entry, err := writer.CreateHeader(header)
	if err != nil {
		return err
	}
	_, err = entry.Write(data)
	return err
}

func writeZipFile(writer *zip.Writer, name, path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	header := &zip.FileHeader{Name: name, Method: zip.Store}
	header.SetMode(0600)
	entry, err := writer.CreateHeader(header)
	if err != nil {
		return err
	}
	_, err = io.Copy(entry, file)
	return err
}

func openArchiveEntries(path string) (*zip.ReadCloser, map[string]*zip.File, error) {
	reader, err := zip.OpenReader(path)
	if err != nil {
		return nil, nil, err
	}
	entries := make(map[string]*zip.File, len(reader.File))
	for _, file := range reader.File {
		clean := filepath.ToSlash(filepath.Clean(file.Name))
		if clean != file.Name || strings.HasPrefix(clean, "../") || strings.HasPrefix(clean, "/") {
			_ = reader.Close()
			return nil, nil, fmt.Errorf("unsafe path in Kavla archive: %q", file.Name)
		}
		if _, duplicate := entries[file.Name]; duplicate {
			_ = reader.Close()
			return nil, nil, fmt.Errorf("duplicate path in Kavla archive: %q", file.Name)
		}
		entries[file.Name] = file
	}
	return reader, entries, nil
}

func validateBlobEntry(file *zip.File, descriptor BlobDescriptor) error {
	if file.UncompressedSize64 > uint64(1<<63-1) || int64(file.UncompressedSize64) != descriptor.Size {
		return fmt.Errorf("blob %s size does not match manifest", descriptor.ID)
	}
	return nil
}

func (d *Document) ensureBlobExtractedLocked(id string, descriptor BlobDescriptor) error {
	destination := filepath.Join(d.workingDir, "blobs", id)
	if _, err := os.Stat(destination); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect staged blob %s: %w", id, err)
	}

	reader, entries, err := openArchiveEntries(d.path)
	if err != nil {
		return fmt.Errorf("open Kavla archive for blob %s: %w", id, err)
	}
	defer reader.Close()
	entry := entries["blobs/"+id]
	if entry == nil {
		return fmt.Errorf("archive is missing blob %s", id)
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
		return fmt.Errorf("create working blob directory: %w", err)
	}
	return extractBlob(entry, destination, descriptor)
}

func readZipEntry(file *zip.File, limit int64) ([]byte, error) {
	if file == nil {
		return nil, os.ErrNotExist
	}
	if int64(file.UncompressedSize64) > limit {
		return nil, fmt.Errorf("entry exceeds size limit")
	}
	reader, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	data, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("entry exceeds size limit")
	}
	return data, nil
}

func extractBlob(file *zip.File, destination string, descriptor BlobDescriptor) error {
	if err := validateBlobEntry(file, descriptor); err != nil {
		return err
	}
	reader, err := file.Open()
	if err != nil {
		return err
	}
	defer reader.Close()
	temp, err := os.CreateTemp(filepath.Dir(destination), ".extract-*")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	hash := sha256.New()
	if _, err := io.Copy(io.MultiWriter(temp, hash), reader); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if hex.EncodeToString(hash.Sum(nil)) != descriptor.SHA256 {
		return fmt.Errorf("blob %s checksum does not match manifest", descriptor.ID)
	}
	if err := os.Chmod(tempName, 0600); err != nil {
		return err
	}
	return os.Rename(tempName, destination)
}

func verifyBlobFile(path string, descriptor BlobDescriptor) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if info.Size() != descriptor.Size {
		return fmt.Errorf("size does not match manifest")
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return err
	}
	if hex.EncodeToString(hash.Sum(nil)) != descriptor.SHA256 {
		return fmt.Errorf("checksum does not match manifest")
	}
	return nil
}
