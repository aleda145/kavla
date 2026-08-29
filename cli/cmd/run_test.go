package cmd

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
	"github.com/aleda145/kavla/cli/internal/localapp"
	_ "github.com/duckdb/duckdb-go/v2"
	"github.com/spf13/cobra"
)

func TestDefaultCanvasPath(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	path, err := defaultCanvasPath()
	if err != nil {
		t.Fatalf("default canvas path: %v", err)
	}

	want := filepath.Join(home, ".kavla", "titanic.kavla")
	if path != want {
		t.Fatalf("default canvas path = %q, want %q", path, want)
	}
}

func TestDefaultTitanicDatabasePath(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	path, err := defaultTitanicDatabasePath()
	if err != nil {
		t.Fatalf("default Titanic database path: %v", err)
	}

	want := filepath.Join(home, ".kavla", "titanic.duckdb")
	if path != want {
		t.Fatalf("default Titanic database path = %q, want %q", path, want)
	}
}

func TestStartupCanvasPathUsesTheMostRecentlyOpenedDocument(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	recentPath := filepath.Join(t.TempDir(), "analysis.kavla")
	if err := os.WriteFile(recentPath, []byte("document"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := kavlaconfig.SaveConfig(&kavlaconfig.Config{LastDocument: recentPath}); err != nil {
		t.Fatal(err)
	}

	path, err := startupCanvasPath()
	if err != nil {
		t.Fatalf("startup canvas path: %v", err)
	}
	if path != recentPath {
		t.Fatalf("startup canvas path = %q, want %q", path, recentPath)
	}
}

func TestStartupCanvasPathFallsBackWhenTheRecentDocumentIsMissing(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := kavlaconfig.SaveConfig(&kavlaconfig.Config{LastDocument: filepath.Join(home, "missing.kavla")}); err != nil {
		t.Fatal(err)
	}

	path, err := startupCanvasPath()
	if err != nil {
		t.Fatalf("startup canvas path: %v", err)
	}
	want := filepath.Join(home, ".kavla", "titanic.kavla")
	if path != want {
		t.Fatalf("startup canvas path = %q, want %q", path, want)
	}
}

func TestEnsureBundledStarterCanvasCreatesTitanicDemo(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".kavla", defaultCanvasFilename)
	if err := ensureBundledStarterCanvas(path); err != nil {
		t.Fatalf("ensure bundled starter canvas: %v", err)
	}

	document, err := localapp.OpenDocument(path)
	if err != nil {
		t.Fatalf("open bundled starter canvas: %v", err)
	}
	t.Cleanup(func() {
		_ = document.CleanupWorkingCopy()
	})
	manifest := document.Manifest()
	if manifest.DocumentName != "titanic" {
		t.Fatalf("starter document name = %q, want %q", manifest.DocumentName, "titanic")
	}
	if len(document.CanvasJSON()) == 0 {
		t.Fatal("starter document canvas is empty")
	}
	if len(manifest.Blobs) == 0 {
		t.Fatal("starter document has no bundled blobs")
	}
}

func TestEnsureBundledStarterCanvasDoesNotOverwriteExistingDocument(t *testing.T) {
	path := filepath.Join(t.TempDir(), defaultCanvasFilename)
	existing := []byte("existing document")
	if err := os.WriteFile(path, existing, 0600); err != nil {
		t.Fatal(err)
	}
	if err := ensureBundledStarterCanvas(path); err != nil {
		t.Fatalf("ensure bundled starter canvas: %v", err)
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != string(existing) {
		t.Fatalf("existing document was overwritten: got %q", contents)
	}
}

func TestEnsureBundledTitanicSourceCreatesDatabaseAndConfiguration(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	if err := ensureBundledTitanicSource(); err != nil {
		t.Fatalf("ensure bundled Titanic source: %v", err)
	}

	databasePath := filepath.Join(home, ".kavla", defaultTitanicDatabaseFilename)
	database, err := sql.Open("duckdb", databasePath)
	if err != nil {
		t.Fatalf("open seeded Titanic database: %v", err)
	}
	defer database.Close()
	var rowCount int
	if err := database.QueryRow("SELECT COUNT(*) FROM titanic").Scan(&rowCount); err != nil {
		t.Fatalf("query seeded Titanic database: %v", err)
	}
	if rowCount != 891 {
		t.Fatalf("seeded Titanic row count = %d, want 891", rowCount)
	}

	config, err := kavlaconfig.LoadConfig()
	if err != nil {
		t.Fatalf("load seeded source configuration: %v", err)
	}
	source, exists := config.Sources[defaultTitanicSourceName]
	if !exists {
		t.Fatal("Titanic source was not configured")
	}
	if source.Type != "duckdb" || source.Connection != databasePath {
		t.Fatalf("Titanic source = %+v, want DuckDB connection %q", source, databasePath)
	}
}

func TestEnsureBundledTitanicSourceDoesNotOverwriteExistingDatabaseOrSource(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	databasePath := filepath.Join(home, ".kavla", defaultTitanicDatabaseFilename)
	if err := os.MkdirAll(filepath.Dir(databasePath), 0700); err != nil {
		t.Fatal(err)
	}
	existingDatabase := []byte("existing database")
	if err := os.WriteFile(databasePath, existingDatabase, 0600); err != nil {
		t.Fatal(err)
	}
	existingSource := kavlaconfig.SourceConfig{Type: "duckdb", Connection: "/custom/titanic.duckdb"}
	if err := kavlaconfig.SaveConfig(&kavlaconfig.Config{
		Sources: map[string]kavlaconfig.SourceConfig{defaultTitanicSourceName: existingSource},
	}); err != nil {
		t.Fatal(err)
	}

	if err := ensureBundledTitanicSource(); err != nil {
		t.Fatalf("ensure bundled Titanic source: %v", err)
	}

	contents, err := os.ReadFile(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != string(existingDatabase) {
		t.Fatalf("existing Titanic database was overwritten: got %q", contents)
	}
	config, err := kavlaconfig.LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if source := config.Sources[defaultTitanicSourceName]; source != existingSource {
		t.Fatalf("existing Titanic source was overwritten: got %+v", source)
	}
}

func TestRunCommandIsRegistered(t *testing.T) {
	command, _, err := rootCmd.Find([]string{"run"})
	if err != nil {
		t.Fatalf("find run command: %v", err)
	}
	if command != runCmd {
		t.Fatalf("run command was not registered")
	}
}

func TestServerCommandsDefaultToLocalhost(t *testing.T) {
	for _, command := range []*cobra.Command{runCmd, openCmd} {
		hostFlag := command.Flags().Lookup("host")
		if hostFlag == nil {
			t.Fatalf("%s command has no host flag", command.Name())
		}
		if hostFlag.DefValue != "localhost" {
			t.Fatalf("%s command host default = %q, want localhost", command.Name(), hostFlag.DefValue)
		}
	}
}

func TestDefaultPortFallsBackOnlyWhenPortFlagWasNotSet(t *testing.T) {
	command := &cobra.Command{Use: "test"}
	port := defaultServerPort
	command.Flags().IntVar(&port, "port", defaultServerPort, "HTTP port")

	if !shouldFallbackFromDefaultPort(command, port) {
		t.Fatal("expected an unchanged default port to allow fallback")
	}
	if err := command.Flags().Set("port", "40743"); err != nil {
		t.Fatal(err)
	}
	if shouldFallbackFromDefaultPort(command, port) {
		t.Fatal("expected an explicit default port to remain strict")
	}
}
