package localapp

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"
)

type archiveBlobServer struct {
	mu       sync.RWMutex
	document *Document
	server   *http.Server
	address  string
	token    string
}

func (d *Document) BlobURL(id string) (string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	blob, ok := d.blobs[id]
	if !ok {
		return "", os.ErrNotExist
	}
	if d.blobServer == nil {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return "", err
		}
		b := &archiveBlobServer{document: d, address: listener.Addr().String(), token: uuid.NewString()}
		b.server = &http.Server{Handler: b, ReadHeaderTimeout: 10 * time.Second}
		d.blobServer = b
		go func() {
			if err := b.server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Printf("Archive range server stopped: %v", err)
			}
		}()
	}
	return "http://" + d.blobServer.address + "/" + d.blobServer.token + "/" + url.PathEscape(id) + "?v=" + blob.SHA256, nil
}

func (b *archiveBlobServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Host != b.address || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
		http.NotFound(w, r)
		return
	}
	prefix := "/" + b.token + "/"
	if len(r.URL.Path) <= len(prefix) || r.URL.Path[:len(prefix)] != prefix {
		http.NotFound(w, r)
		return
	}
	b.mu.RLock()
	d := b.document
	b.mu.RUnlock()
	reader, blob, close, err := d.OpenBlob(r.URL.Path[len(prefix):])
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, os.ErrNotExist) {
			status = http.StatusNotFound
		}
		http.Error(w, err.Error(), status)
		return
	}
	defer close()
	if r.URL.Query().Get("v") != blob.SHA256 {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("ETag", `"`+blob.SHA256+`"`)
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeContent(w, r, blob.FileName, time.Time{}, reader)
}

// Stored ZIP entries are seekable ranges of the original archive. An open file
// handle pins their immutable bytes without locking canvas edits while a range
// is being served. Compressed legacy entries use the
// bounded disk extraction path only when that individual blob is requested.
func (d *Document) OpenBlob(id string) (io.ReadSeeker, BlobDescriptor, func(), error) {
	d.mu.RLock()
	blob, ok := d.blobs[id]
	if !ok {
		d.mu.RUnlock()
		return nil, blob, nil, os.ErrNotExist
	}
	staged := filepath.Join(d.workingDir, "blobs", stagedBlobName(id))
	f, err := os.Open(staged)
	if err == nil {
		d.mu.RUnlock()
		return f, blob, func() { _ = f.Close() }, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		d.mu.RUnlock()
		return nil, blob, nil, err
	}
	archive, entries, err := openArchiveEntries(d.archivePath)
	if err != nil {
		d.mu.RUnlock()
		return nil, blob, nil, err
	}
	entry := entries["blobs/"+id]
	if entry == nil {
		archive.Close()
		d.mu.RUnlock()
		return nil, blob, nil, fmt.Errorf("missing archived blob %s", id)
	}
	if err := validateBlobEntry(entry, blob); err != nil {
		archive.Close()
		d.mu.RUnlock()
		return nil, blob, nil, err
	}
	if entry.Method == zip.Store {
		offset, err := entry.DataOffset()
		if err != nil {
			archive.Close()
			d.mu.RUnlock()
			return nil, blob, nil, err
		}
		if offset < 0 || offset > archive.size || blob.Size > archive.size-offset {
			archive.Close()
			d.mu.RUnlock()
			return nil, blob, nil, fmt.Errorf("invalid archived blob range")
		}
		d.mu.RUnlock()
		return io.NewSectionReader(archive.file, offset, blob.Size), blob, func() { _ = archive.Close() }, nil
	}
	archive.Close()
	d.mu.RUnlock()
	if _, _, err := d.BlobPath(id); err != nil {
		return nil, blob, nil, err
	}
	return d.OpenBlob(id)
}
