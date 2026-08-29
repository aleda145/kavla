package updater

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestCheckUsesCacheAndNotifiesOnce(t *testing.T) {
	now := time.Date(2026, time.March, 24, 12, 0, 0, 0, time.UTC)
	archive := makeArchive(t, []byte("new-binary"))
	checksum := sha256Hex(archive)

	var manifestHits atomic.Int32
	var serverURL string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/manifest":
			manifestHits.Add(1)
			_ = json.NewEncoder(w).Encode(Manifest{
				Version:  "v0.2.0",
				NotesURL: "https://example.com/release",
				Assets: map[string]Asset{
					"linux-amd64": {
						URL:           serverURL + "/archive",
						SHA256:        checksum,
						ArchiveFormat: "tar.gz",
						BinaryName:    "kavla",
					},
				},
			})
		case "/archive":
			_, _ = w.Write(archive)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	serverURL = server.URL

	updater := &Updater{
		manifestURL:    server.URL + "/manifest",
		statePath:      filepath.Join(t.TempDir(), "updater.json"),
		httpClient:     server.Client(),
		now:            func() time.Time { return now },
		executablePath: func() (string, error) { return "", errors.New("unused") },
		goos:           "linux",
		goarch:         "amd64",
		cacheWindow:    24 * time.Hour,
	}

	result, err := updater.Check(context.Background(), "v0.1.0")
	if err != nil {
		t.Fatalf("Check returned error: %v", err)
	}
	if !result.UpdateAvailable {
		t.Fatal("expected update to be available")
	}
	if !result.ShouldNotify {
		t.Fatal("expected first check to notify")
	}
	if got := manifestHits.Load(); got != 1 {
		t.Fatalf("expected one manifest fetch, got %d", got)
	}

	result, err = updater.Check(context.Background(), "v0.1.0")
	if err != nil {
		t.Fatalf("second Check returned error: %v", err)
	}
	if !result.UpdateAvailable {
		t.Fatal("expected cached update to still be available")
	}
	if result.ShouldNotify {
		t.Fatal("expected cached check to suppress duplicate notice")
	}
	if got := manifestHits.Load(); got != 1 {
		t.Fatalf("expected cached check to skip manifest fetch, got %d", got)
	}
}

func TestCheckReturnsErrSourceBuild(t *testing.T) {
	_, err := New().Check(context.Background(), "dev")
	if !errors.Is(err, ErrSourceBuild) {
		t.Fatalf("expected ErrSourceBuild, got %v", err)
	}
}

func TestAssetForCurrentPlatformUnsupported(t *testing.T) {
	updater := &Updater{goos: "freebsd", goarch: "amd64"}
	_, err := updater.assetForCurrentPlatform(Manifest{
		Assets: map[string]Asset{
			"linux-amd64": {URL: "https://example.com", SHA256: "abc", ArchiveFormat: "tar.gz", BinaryName: "kavla"},
		},
	})
	if !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("expected ErrUnsupportedPlatform, got %v", err)
	}
}

func TestUpdateReplacesExecutable(t *testing.T) {
	archive := makeArchive(t, []byte("new-binary"))
	checksum := sha256Hex(archive)

	execPath := filepath.Join(t.TempDir(), "kavla")
	if err := os.WriteFile(execPath, []byte("old-binary"), 0755); err != nil {
		t.Fatalf("write exec file: %v", err)
	}

	var serverURL string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/manifest":
			_ = json.NewEncoder(w).Encode(Manifest{
				Version:  "v0.2.0",
				NotesURL: "https://example.com/release",
				Assets: map[string]Asset{
					"linux-amd64": {
						URL:           serverURL + "/archive",
						SHA256:        checksum,
						ArchiveFormat: "tar.gz",
						BinaryName:    "kavla",
					},
				},
			})
		case "/archive":
			_, _ = w.Write(archive)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	serverURL = server.URL

	updater := &Updater{
		manifestURL:    server.URL + "/manifest",
		statePath:      filepath.Join(t.TempDir(), "updater.json"),
		httpClient:     server.Client(),
		now:            time.Now,
		executablePath: func() (string, error) { return execPath, nil },
		goos:           "linux",
		goarch:         "amd64",
		cacheWindow:    24 * time.Hour,
	}

	result, err := updater.Update(context.Background(), "v0.1.0")
	if err != nil {
		t.Fatalf("Update returned error: %v", err)
	}
	if !result.Updated {
		t.Fatal("expected update to replace executable")
	}
	updatedBytes, err := os.ReadFile(execPath)
	if err != nil {
		t.Fatalf("read updated executable: %v", err)
	}
	if got := string(updatedBytes); got != "new-binary" {
		t.Fatalf("unexpected executable contents: %q", got)
	}
}

func TestUpdateRejectsChecksumMismatch(t *testing.T) {
	archive := makeArchive(t, []byte("new-binary"))

	var serverURL string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/manifest":
			_ = json.NewEncoder(w).Encode(Manifest{
				Version: "v0.2.0",
				Assets: map[string]Asset{
					"linux-amd64": {
						URL:           serverURL + "/archive",
						SHA256:        strings.Repeat("0", 64),
						ArchiveFormat: "tar.gz",
						BinaryName:    "kavla",
					},
				},
			})
		case "/archive":
			_, _ = w.Write(archive)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	serverURL = server.URL

	updater := &Updater{
		manifestURL:    server.URL + "/manifest",
		statePath:      filepath.Join(t.TempDir(), "updater.json"),
		httpClient:     server.Client(),
		now:            time.Now,
		executablePath: func() (string, error) { return filepath.Join(t.TempDir(), "kavla"), nil },
		goos:           "linux",
		goarch:         "amd64",
		cacheWindow:    24 * time.Hour,
	}

	_, err := updater.Update(context.Background(), "v0.1.0")
	if err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("expected checksum mismatch error, got %v", err)
	}
}

func makeArchive(t *testing.T, binary []byte) []byte {
	t.Helper()

	var buffer bytes.Buffer
	gzipWriter := gzip.NewWriter(&buffer)
	tarWriter := tar.NewWriter(gzipWriter)

	header := &tar.Header{
		Name: "kavla",
		Mode: 0755,
		Size: int64(len(binary)),
	}
	if err := tarWriter.WriteHeader(header); err != nil {
		t.Fatalf("write tar header: %v", err)
	}
	if _, err := tarWriter.Write(binary); err != nil {
		t.Fatalf("write tar body: %v", err)
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatalf("close tar writer: %v", err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatalf("close gzip writer: %v", err)
	}

	return buffer.Bytes()
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
