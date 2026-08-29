package cmd

import (
	"fmt"
	"os"
	"regexp"
	"strings"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
	"github.com/aleda145/kavla/cli/internal/sources"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

var (
	sourceName       string
	sourceType       string
	sourceConnection string

	sourceNamePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]*$`)
)

type sourcePromptOption struct {
	Value string
	Label string
}

type addSourcePrompter interface {
	Select(label string, options []sourcePromptOption) (string, error)
	Input(label, help string) (string, error)
}

var addSourceCmd = &cobra.Command{
	Use:   "add-source",
	Short: "Add a new data source",
	Run: func(cmd *cobra.Command, args []string) {
		interactive := term.IsTerminal(int(os.Stdin.Fd())) && term.IsTerminal(int(os.Stdout.Fd()))
		if err := runAddSourceWithPrompter(newTerminalSourcePrompter(), interactive); err != nil {
			fmt.Printf("Error: %v\n", err)
		}
	},
}

func runAddSourceWithPrompter(prompter addSourcePrompter, interactive bool) error {
	config, err := kavlaconfig.LoadConfigAllowMissing()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	if config.Sources == nil {
		config.Sources = make(map[string]kavlaconfig.SourceConfig)
	}

	name, sourceConfig, err := resolveAddSourceConfig(config, prompter, interactive)
	if err != nil {
		return err
	}

	config.Sources[name] = sourceConfig
	if err := kavlaconfig.SaveConfig(config); err != nil {
		return fmt.Errorf("save config: %w", err)
	}

	configPath, err := kavlaconfig.GetConfigPath()
	if err != nil {
		return fmt.Errorf("get config path: %w", err)
	}

	fmt.Printf("Source '%s' (%s) added successfully.\n", name, sourceConfig.Type)
	fmt.Printf("Config saved to %s\n", configPath)
	return nil
}

func resolveAddSourceConfig(config *kavlaconfig.Config, prompter addSourcePrompter, interactive bool) (string, kavlaconfig.SourceConfig, error) {
	definitionMap := sources.BuiltInDefinitionMap()
	definitions := sources.BuiltInDefinitions()

	selectedType, definition, err := resolveSourceType(definitions, definitionMap, prompter, interactive)
	if err != nil {
		return "", kavlaconfig.SourceConfig{}, err
	}

	name, err := resolveSourceName(config.Sources, prompter, interactive)
	if err != nil {
		return "", kavlaconfig.SourceConfig{}, err
	}

	connection, err := resolveSourceConnection(definition, prompter, interactive)
	if err != nil {
		return "", kavlaconfig.SourceConfig{}, err
	}

	return name, kavlaconfig.SourceConfig{
		Type:       selectedType,
		Connection: connection,
	}, nil
}

func resolveSourceType(definitions []sources.Definition, definitionMap map[string]sources.Definition, prompter addSourcePrompter, interactive bool) (string, sources.Definition, error) {
	providedType := strings.ToLower(strings.TrimSpace(sourceType))
	if providedType != "" {
		definition, ok := definitionMap[providedType]
		if !ok {
			return "", sources.Definition{}, fmt.Errorf("unsupported source type %q. Supported types: %s", providedType, sources.SupportedTypesString())
		}
		return providedType, definition, nil
	}

	if !interactive {
		return "", sources.Definition{}, missingAddSourceFlagsError("--type")
	}

	options := make([]sourcePromptOption, 0, len(definitions))
	for _, definition := range definitions {
		options = append(options, sourcePromptOption{Value: definition.Type, Label: definition.Label})
	}

	selectedType, err := prompter.Select("Select a source type:", options)
	if err != nil {
		return "", sources.Definition{}, wrapPromptError(err)
	}

	definition, ok := definitionMap[selectedType]
	if !ok {
		return "", sources.Definition{}, fmt.Errorf("unsupported source type %q. Supported types: %s", selectedType, sources.SupportedTypesString())
	}
	return selectedType, definition, nil
}

func resolveSourceName(existing map[string]kavlaconfig.SourceConfig, prompter addSourcePrompter, interactive bool) (string, error) {
	providedName := strings.TrimSpace(sourceName)
	if providedName != "" {
		if err := validateSourceName(providedName, existing); err != nil {
			return "", err
		}
		return providedName, nil
	}

	if !interactive {
		return "", missingAddSourceFlagsError("--name")
	}

	for {
		name, err := prompter.Input("Source name", "Letters, numbers, and underscores only. Must start with a letter.")
		if err != nil {
			return "", wrapPromptError(err)
		}
		if err := validateSourceName(name, existing); err != nil {
			fmt.Printf("Invalid source name: %v\n", err)
			continue
		}
		return name, nil
	}
}

func resolveSourceConnection(definition sources.Definition, prompter addSourcePrompter, interactive bool) (string, error) {
	if strings.TrimSpace(sourceConnection) != "" {
		return resolveProvidedConnection(definition, sourceConnection)
	}

	if !interactive {
		return "", missingAddSourceFlagsError("--connection")
	}

	for {
		connection, err := prompter.Input(definition.Prompt.Label, definition.Prompt.Help)
		if err != nil {
			return "", wrapPromptError(err)
		}
		resolved, err := definition.ResolveConnection(connection)
		if err != nil {
			fmt.Printf("Invalid %s: %v\n", strings.ToLower(definition.Prompt.Label), err)
			continue
		}
		return resolved, nil
	}
}

func resolveProvidedConnection(definition sources.Definition, raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", fmt.Errorf("connection is required")
	}
	if definition.Type == "bigquery" {
		return trimmed, nil
	}
	return definition.ResolveConnection(trimmed)
}

func validateSourceName(name string, existing map[string]kavlaconfig.SourceConfig) error {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return fmt.Errorf("name is required")
	}
	if !sourceNamePattern.MatchString(trimmed) {
		return fmt.Errorf("must match %s", sourceNamePattern.String())
	}
	if _, exists := existing[trimmed]; exists {
		return fmt.Errorf("source %q already exists", trimmed)
	}
	return nil
}

func missingAddSourceFlagsError(flags ...string) error {
	return fmt.Errorf("missing required flags: %s; provide the missing flags or run the command in a terminal", strings.Join(flags, ", "))
}

func wrapPromptError(err error) error {
	if err == nil {
		return nil
	}
	if err == errPromptCancelled {
		return fmt.Errorf("source setup cancelled")
	}
	return err
}

var listSourcesCmd = &cobra.Command{
	Use:   "list-sources",
	Short: "List configured data sources",
	Run: func(cmd *cobra.Command, args []string) {
		config, err := kavlaconfig.LoadConfig()
		if err != nil || config.Sources == nil || len(config.Sources) == 0 {
			fmt.Println("No sources configured.")
			return
		}

		fmt.Println("Configured Sources:")
		for name, src := range config.Sources {
			fmt.Printf("- %s (%s)\n", name, src.Type)
		}
	},
}

var removeSourceCmd = &cobra.Command{
	Use:   "remove-source [NAME]",
	Short: "Remove a data source",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		name := args[0]
		config, err := kavlaconfig.LoadConfig()
		if err != nil {
			fmt.Println("Error loading config.")
			return
		}

		if _, exists := config.Sources[name]; !exists {
			fmt.Printf("Source '%s' not found.\n", name)
			return
		}

		delete(config.Sources, name)
		if err := kavlaconfig.SaveConfig(config); err != nil {
			fmt.Printf("Error saving config: %v\n", err)
			return
		}
		fmt.Printf("Source '%s' removed.\n", name)
	},
}

func init() {
	addSourceCmd.Flags().StringVar(&sourceName, "name", "", "Name of the source")
	addSourceCmd.Flags().StringVar(&sourceType, "type", "", "Type of source (duckdb, directory, bigquery, postgres)")
	addSourceCmd.Flags().StringVar(&sourceConnection, "connection", "", "Connection string, file path, or project ID")

	configCmd.AddCommand(addSourceCmd)
	configCmd.AddCommand(listSourcesCmd)
	configCmd.AddCommand(removeSourceCmd)
}
