package cmd

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
	"github.com/aleda145/kavla/cli/internal/demo"
	"github.com/spf13/cobra"
)

const defaultCanvasFilename = "titanic.kavla"
const defaultTitanicDatabaseFilename = "titanic.duckdb"
const defaultTitanicSourceName = "titanic"
const defaultServerHost = "localhost"
const defaultServerPort = 40743

var runNoBrowser bool
var runHost string
var runPort int

var runCmd = &cobra.Command{
	Use:   "run",
	Short: "Start Kavla with the most recently opened local canvas",
	Long: `Start the local Kavla web server, reopen the most recently used canvas,
and make all configured CLI data sources available to it. First-time runs seed
~/.kavla/titanic.kavla and a Titanic DuckDB source from the bundled demo.`,
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		documentPath, err := startupCanvasPath()
		if err != nil {
			return err
		}
		if err := ensureBundledStarterCanvas(documentPath); err != nil {
			return err
		}
		return runDocument(
			documentPath,
			runNoBrowser,
			"Running Kavla with",
			runHost,
			runPort,
			shouldFallbackFromDefaultPort(cmd, runPort),
		)
	},
}

func ensureBundledStarterCanvas(path string) error {
	return ensureBundledFile(path, demo.TitanicArchive(), ".starter-*.kavla", "starter Kavla document")
}

func ensureBundledTitanicSource() error {
	databasePath, err := defaultTitanicDatabasePath()
	if err != nil {
		return err
	}
	if err := ensureBundledFile(databasePath, demo.TitanicDatabase(), ".starter-*.duckdb", "starter Titanic database"); err != nil {
		return err
	}

	config, err := kavlaconfig.LoadConfigAllowMissing()
	if err != nil {
		return fmt.Errorf("load Kavla configuration: %w", err)
	}
	if config.Sources == nil {
		config.Sources = make(map[string]kavlaconfig.SourceConfig)
	}
	if _, exists := config.Sources[defaultTitanicSourceName]; exists {
		return nil
	}
	config.Sources[defaultTitanicSourceName] = kavlaconfig.SourceConfig{
		Type:       "duckdb",
		Connection: databasePath,
	}
	if err := kavlaconfig.SaveConfig(config); err != nil {
		return fmt.Errorf("configure starter Titanic source: %w", err)
	}
	return nil
}

func ensureBundledFile(path string, contents []byte, temporaryPattern, description string) error {
	info, err := os.Stat(path)
	if err == nil {
		if !info.Mode().IsRegular() {
			return fmt.Errorf("%s path is not a regular file: %s", description, path)
		}
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect %s: %w", description, err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return fmt.Errorf("create Kavla configuration directory: %w", err)
	}

	file, err := os.CreateTemp(filepath.Dir(path), temporaryPattern)
	if err != nil {
		return fmt.Errorf("create temporary %s: %w", description, err)
	}
	temporaryPath := file.Name()
	defer os.Remove(temporaryPath)
	if _, err := file.Write(contents); err != nil {
		_ = file.Close()
		return fmt.Errorf("write %s: %w", description, err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close %s: %w", description, err)
	}
	if err := os.Chmod(temporaryPath, 0600); err != nil {
		return fmt.Errorf("secure %s: %w", description, err)
	}
	if err := os.Link(temporaryPath, path); errors.Is(err, os.ErrExist) {
		return nil
	} else if err != nil {
		return fmt.Errorf("publish %s: %w", description, err)
	}
	return nil
}

func startupCanvasPath() (string, error) {
	fallbackPath, err := defaultCanvasPath()
	if err != nil {
		return "", err
	}
	config, err := kavlaconfig.LoadConfigAllowMissing()
	if err != nil {
		return "", fmt.Errorf("load Kavla configuration: %w", err)
	}
	recentPath := strings.TrimSpace(config.LastDocument)
	if recentPath == "" || !filepath.IsAbs(recentPath) || !strings.EqualFold(filepath.Ext(recentPath), ".kavla") {
		return fallbackPath, nil
	}
	info, err := os.Stat(recentPath)
	if err == nil && info.Mode().IsRegular() {
		return filepath.Clean(recentPath), nil
	}
	if err != nil && !os.IsNotExist(err) {
		return "", fmt.Errorf("inspect recently opened Kavla document: %w", err)
	}
	return fallbackPath, nil
}

func shouldFallbackFromDefaultPort(cmd *cobra.Command, port int) bool {
	return port == defaultServerPort && !cmd.Flags().Changed("port")
}

func defaultCanvasPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home directory: %w", err)
	}
	return filepath.Join(home, ".kavla", defaultCanvasFilename), nil
}

func defaultTitanicDatabasePath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home directory: %w", err)
	}
	return filepath.Join(home, ".kavla", defaultTitanicDatabaseFilename), nil
}

func init() {
	runCmd.Flags().BoolVar(&runNoBrowser, "no-browser", false, "Run headlessly and print the server URL")
	runCmd.Flags().StringVar(&runHost, "host", defaultServerHost, "Address to listen on (use 0.0.0.0 for remote access)")
	runCmd.Flags().IntVar(&runPort, "port", defaultServerPort, "HTTP port to listen on (chooses another if the default is busy)")
	rootCmd.AddCommand(runCmd)
}
