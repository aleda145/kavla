package sources

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type PromptKind string

const (
	PromptKindPathFile      PromptKind = "path_file"
	PromptKindPathDirectory PromptKind = "path_directory"
	PromptKindText          PromptKind = "text"
)

type Prompt struct {
	Label string
	Help  string
	Kind  PromptKind
}

type Definition struct {
	Type              string
	Label             string
	NewAdapter        AdapterFactory
	Prompt            Prompt
	ResolveConnection func(string) (string, error)
}

func BuiltInDefinitions() []Definition {
	return []Definition{
		{
			Type:       "duckdb",
			Label:      "DuckDB",
			NewAdapter: func() Adapter { return &duckDBAdapter{} },
			Prompt: Prompt{
				Label: "DuckDB file path",
				Help:  "Relative or absolute path to an existing DuckDB file. Example: ./analytics.duckdb",
				Kind:  PromptKindPathFile,
			},
			ResolveConnection: resolveExistingFilePath,
		},
		{
			Type:       "directory",
			Label:      "Directory",
			NewAdapter: func() Adapter { return &directoryAdapter{} },
			Prompt: Prompt{
				Label: "Directory path",
				Help:  "Relative or absolute path to a directory with CSV, Parquet, or JSON files. Example: .",
				Kind:  PromptKindPathDirectory,
			},
			ResolveConnection: resolveExistingDirectoryPath,
		},
		{
			Type:       "bigquery",
			Label:      "BigQuery (Experimental)",
			NewAdapter: func() Adapter { return &bigQueryAdapter{} },
			Prompt: Prompt{
				Label: "BigQuery project ID",
				Help:  "Google Cloud project ID. Example: my-analytics-project",
				Kind:  PromptKindText,
			},
			ResolveConnection: resolveBigQueryProjectID,
		},
		{
			Type:       "postgres",
			Label:      "Postgres",
			NewAdapter: func() Adapter { return &postgresAdapter{} },
			Prompt: Prompt{
				Label: "Postgres connection string",
				Help:  "Postgres DSN or URI. Example: postgres://user:password@host:5432/dbname?sslmode=require",
				Kind:  PromptKindText,
			},
			ResolveConnection: resolvePostgresConnection,
		},
	}
}

func BuiltInDefinitionMap() map[string]Definition {
	definitions := BuiltInDefinitions()
	definitionMap := make(map[string]Definition, len(definitions))
	for _, definition := range definitions {
		definitionMap[definition.Type] = definition
	}
	return definitionMap
}

func SupportedTypes() []string {
	definitions := BuiltInDefinitions()
	supported := make([]string, 0, len(definitions))
	for _, definition := range definitions {
		supported = append(supported, definition.Type)
	}
	return supported
}

func SupportedTypesString() string {
	return strings.Join(SupportedTypes(), ", ")
}

func normalizeLocalPath(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", fmt.Errorf("path is required")
	}

	if len(value) >= 2 {
		if (value[0] == '"' && value[len(value)-1] == '"') || (value[0] == '\'' && value[len(value)-1] == '\'') {
			value = value[1 : len(value)-1]
		}
	}

	if strings.HasPrefix(value, "~") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolve home directory: %w", err)
		}
		switch {
		case value == "~":
			value = home
		case strings.HasPrefix(value, "~/"):
			value = filepath.Join(home, value[2:])
		}
	}

	absPath, err := filepath.Abs(value)
	if err != nil {
		return "", fmt.Errorf("resolve path: %w", err)
	}

	return filepath.Clean(absPath), nil
}

func resolveExistingFilePath(raw string) (string, error) {
	path, err := normalizeLocalPath(raw)
	if err != nil {
		return "", err
	}

	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", fmt.Errorf("file does not exist: %s", path)
		}
		return "", fmt.Errorf("stat file: %w", err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("expected a file, got a directory: %s", path)
	}

	return path, nil
}

func resolveExistingDirectoryPath(raw string) (string, error) {
	path, err := normalizeLocalPath(raw)
	if err != nil {
		return "", err
	}

	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", fmt.Errorf("directory does not exist: %s", path)
		}
		return "", fmt.Errorf("stat directory: %w", err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("expected a directory, got a file: %s", path)
	}

	return path, nil
}

func resolveBigQueryProjectID(raw string) (string, error) {
	projectID := strings.TrimSpace(raw)
	if strings.HasPrefix(projectID, "project=") {
		projectID = strings.TrimSpace(strings.TrimPrefix(projectID, "project="))
	}
	if projectID == "" {
		return "", fmt.Errorf("project ID is required")
	}
	if strings.ContainsAny(projectID, " \t\r\n") {
		return "", fmt.Errorf("project ID must not contain whitespace")
	}
	return projectID, nil
}

func resolvePostgresConnection(raw string) (string, error) {
	connection := strings.TrimSpace(raw)
	if connection == "" {
		return "", fmt.Errorf("connection string is required")
	}
	return connection, nil
}
