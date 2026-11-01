package localapp

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
)

func TestRegistryRenameUpdatesRegisteredCanvasAndLastOpened(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("USERPROFILE", os.Getenv("HOME"))
	directory := t.TempDir()
	oldPath := filepath.Join(directory, "before.kavla")
	newPath := filepath.Join(directory, "after.kavla")
	document, err := OpenDocument(oldPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = document.CleanupWorkingCopy() })
	if err := document.StageCanvas([]byte(`{"records":[]}`)); err != nil {
		t.Fatal(err)
	}
	if err := document.Save(); err != nil {
		t.Fatal(err)
	}
	runtime := &Server{document: document, assets: fstest.MapFS{}}
	registry, err := newCanvasRegistry(runtime)
	if err != nil {
		t.Fatal(err)
	}
	if err := registry.rename(runtime, newPath); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(oldPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("old archive remains after rename: %v", err)
	}
	if _, err := os.Stat(newPath); err != nil {
		t.Fatalf("renamed archive is missing: %v", err)
	}
	listResponse := httptest.NewRecorder()
	registry.ServeHTTP(listResponse, httptest.NewRequest(http.MethodGet, "/api/canvases", nil))
	if listResponse.Code != http.StatusOK {
		t.Fatalf("list canvases returned %d: %s", listResponse.Code, listResponse.Body.String())
	}
	var entries []struct {
		Name string `json:"name"`
		Path string `json:"path"`
	}
	if err := json.NewDecoder(listResponse.Body).Decode(&entries); err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name != "after" || entries[0].Path != newPath {
		t.Fatalf("canvas list does not reflect rename: %+v", entries)
	}
	rootResponse := httptest.NewRecorder()
	registry.ServeHTTP(rootResponse, httptest.NewRequest(http.MethodGet, "/", nil))
	if rootResponse.Code != http.StatusTemporaryRedirect || rootResponse.Header().Get("Location") != "/after" {
		t.Fatalf("root did not redirect to renamed canvas: %d %q", rootResponse.Code, rootResponse.Header().Get("Location"))
	}
	data, err := os.ReadFile(registry.path)
	if err != nil {
		t.Fatal(err)
	}
	var saved savedCanvasRegistry
	if err := json.Unmarshal(data, &saved); err != nil {
		t.Fatal(err)
	}
	if len(saved.Files) != 1 || saved.Files["after"] != newPath {
		t.Fatalf("registry file does not reflect rename: %+v", saved)
	}
}

func TestRegistryRenameRejectsRegisteredNameConflict(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("USERPROFILE", os.Getenv("HOME"))
	directory := t.TempDir()
	oldPath := filepath.Join(directory, "before.kavla")
	document, err := OpenDocument(oldPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = document.CleanupWorkingCopy() })
	if err := document.StageCanvas([]byte(`{"records":[]}`)); err != nil {
		t.Fatal(err)
	}
	if err := document.Save(); err != nil {
		t.Fatal(err)
	}
	runtime := &Server{document: document, assets: fstest.MapFS{}}
	registry, err := newCanvasRegistry(runtime)
	if err != nil {
		t.Fatal(err)
	}
	takenPath := filepath.Join(t.TempDir(), "taken.kavla")
	taken, err := OpenDocument(takenPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = taken.CleanupWorkingCopy() })
	if err := taken.StageCanvas([]byte(`{"records":[]}`)); err != nil {
		t.Fatal(err)
	}
	if err := taken.Save(); err != nil {
		t.Fatal(err)
	}
	if _, err := registry.openPath(takenPath); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/session/rename", bytes.NewBufferString(`{"name":"taken"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "http://example.com")
	response := httptest.NewRecorder()
	runtime.routes().ServeHTTP(response, request)
	if response.Code != http.StatusConflict {
		t.Fatalf("rename API returned %d for a name conflict, want 409: %s", response.Code, response.Body.String())
	}
	if document.Path() != oldPath {
		t.Fatalf("name conflict changed the active canvas path to %q", document.Path())
	}
	if _, err := os.Stat(oldPath); err != nil {
		t.Fatalf("name conflict moved the archive: %v", err)
	}
}
