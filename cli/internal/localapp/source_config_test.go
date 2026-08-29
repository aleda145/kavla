package localapp

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
)

func newSourceConfigTestServer(t *testing.T) (*Server, http.Handler) {
	t.Helper()
	document, err := OpenDocument(filepath.Join(t.TempDir(), "sources.kavla"))
	if err != nil {
		t.Fatal(err)
	}
	server, err := NewServer(document, fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("ok")}}, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	server.baseURL = "http://127.0.0.1:1234"
	t.Cleanup(func() {
		server.queries.Cancel()
		server.workers.Wait()
		_ = server.queries.Close()
		_ = os.RemoveAll(server.transientDir)
		_ = document.CleanupWorkingCopy()
	})
	return server, server.routes()
}

func sourceRequest(method, path string, body []byte) *http.Request {
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	if method != http.MethodGet {
		request.Header.Set("Origin", "http://example.com")
	}
	request.Header.Set("Content-Type", "application/json")
	return request
}

func decodeCLISourcesResponse(t *testing.T, recorder *httptest.ResponseRecorder) cliSourcesResponse {
	t.Helper()
	if recorder.Code != http.StatusOK {
		t.Fatalf("unexpected response status %d: %s", recorder.Code, recorder.Body.String())
	}
	var response cliSourcesResponse
	if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	return response
}

func TestCLISourceConfigurationCreatesRenamesAndDeletesSource(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	_, handler := newSourceConfigTestServer(t)
	firstDirectory := filepath.Join(t.TempDir(), "first")
	secondDirectory := filepath.Join(t.TempDir(), "second")
	if err := os.MkdirAll(firstDirectory, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(secondDirectory, 0700); err != nil {
		t.Fatal(err)
	}

	createBody, _ := json.Marshal(cliSourceMutationRequest{Name: "local_files", Type: "directory", Connection: firstDirectory})
	createResponse := httptest.NewRecorder()
	handler.ServeHTTP(createResponse, sourceRequest(http.MethodPost, "/api/cli/sources", createBody))
	created := decodeCLISourcesResponse(t, createResponse)
	if len(created.Definitions) != 4 || len(created.Sources) != 1 {
		t.Fatalf("unexpected source configuration response: %+v", created)
	}
	if created.Sources[0].Name != "local_files" || !created.Sources[0].Available {
		t.Fatalf("new source was not activated: %+v", created.Sources[0])
	}
	config, err := kavlaconfig.LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if got := config.Sources["local_files"].Connection; got != firstDirectory {
		t.Fatalf("source was not saved to disk, got %q", got)
	}

	updateBody, _ := json.Marshal(cliSourceMutationRequest{Name: "renamed_files", Type: "directory", Connection: secondDirectory})
	updateResponse := httptest.NewRecorder()
	handler.ServeHTTP(updateResponse, sourceRequest(http.MethodPut, "/api/cli/sources/local_files", updateBody))
	updated := decodeCLISourcesResponse(t, updateResponse)
	if len(updated.Sources) != 1 || updated.Sources[0].Name != "renamed_files" || updated.Sources[0].Connection != secondDirectory {
		t.Fatalf("source was not renamed and updated: %+v", updated.Sources)
	}

	deleteResponse := httptest.NewRecorder()
	handler.ServeHTTP(deleteResponse, sourceRequest(http.MethodDelete, "/api/cli/sources/renamed_files", nil))
	deleted := decodeCLISourcesResponse(t, deleteResponse)
	if len(deleted.Sources) != 0 {
		t.Fatalf("source was not deleted: %+v", deleted.Sources)
	}
	config, err = kavlaconfig.LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if len(config.Sources) != 0 {
		t.Fatalf("deleted source remains on disk: %+v", config.Sources)
	}
}

func TestCLISourceConfigurationDoesNotOverwriteMalformedConfig(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	_, handler := newSourceConfigTestServer(t)
	configPath, err := kavlaconfig.GetConfigPath()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(configPath), 0700); err != nil {
		t.Fatal(err)
	}
	malformed := []byte("sources: [not valid")
	if err := os.WriteFile(configPath, malformed, 0600); err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	body, _ := json.Marshal(cliSourceMutationRequest{Name: "files", Type: "directory", Connection: directory})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, sourceRequest(http.MethodPost, "/api/cli/sources", body))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("expected malformed config error, got %d: %s", response.Code, response.Body.String())
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data, malformed) {
		t.Fatalf("malformed config was overwritten: %q", string(data))
	}
}

func TestCLISourcePathListingIncludesDirectoriesAndFiles(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	_, handler := newSourceConfigTestServer(t)
	directory := t.TempDir()
	if err := os.Mkdir(filepath.Join(directory, "datasets"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "analytics.duckdb"), []byte("test"), 0600); err != nil {
		t.Fatal(err)
	}
	requestPath := "/api/cli/source-paths?path=" + directory
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, sourceRequest(http.MethodGet, requestPath, nil))
	if response.Code != http.StatusOK {
		t.Fatalf("unexpected path response %d: %s", response.Code, response.Body.String())
	}
	var listing struct {
		Entries []struct {
			Name string `json:"name"`
			Type string `json:"type"`
		} `json:"entries"`
	}
	if err := json.NewDecoder(response.Body).Decode(&listing); err != nil {
		t.Fatal(err)
	}
	if len(listing.Entries) != 2 || listing.Entries[0].Type != "directory" || listing.Entries[1].Name != "analytics.duckdb" {
		t.Fatalf("unexpected source path entries: %+v", listing.Entries)
	}
}
