package cmd

import (
	"fmt"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
	"github.com/spf13/cobra"
)

var configCmd = &cobra.Command{
	Use:   "config",
	Short: "Manage Kavla configuration",
}

var setConfigCmd = &cobra.Command{
	Use:    "set",
	Short:  "Dev only: set development configuration",
	Hidden: true,
}

var unsetConfigCmd = &cobra.Command{
	Use:    "unset",
	Short:  "Dev only: unset development configuration",
	Hidden: true,
}

var setDevConfigCmd = &cobra.Command{
	Use:    "dev",
	Short:  "Dev only: use local Kavla servers",
	Long:   "Dev only: use http://localhost:5173 for the app and API, and http://localhost:8090 for authentication.",
	Hidden: true,
	Args:   cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		config, err := kavlaconfig.LoadConfigAllowMissing()
		if err != nil {
			return fmt.Errorf("load config: %w", err)
		}
		config.APIURL = "http://localhost:5173"
		config.AppURL = "http://localhost:5173"
		config.AuthURL = "http://localhost:8090"
		if err := kavlaconfig.SaveConfig(config); err != nil {
			return fmt.Errorf("save config: %w", err)
		}
		cmd.Println("Dev mode enabled: app/API http://localhost:5173, auth http://localhost:8090.")
		return nil
	},
}

var unsetDevConfigCmd = &cobra.Command{
	Use:    "dev",
	Short:  "Dev only: restore production Kavla servers",
	Long:   "Dev only: clear the app, API, and authentication URL overrides to restore the production defaults.",
	Hidden: true,
	Args:   cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		config, err := kavlaconfig.LoadConfigAllowMissing()
		if err != nil {
			return fmt.Errorf("load config: %w", err)
		}
		config.APIURL = ""
		config.AppURL = ""
		config.AuthURL = ""
		if err := kavlaconfig.SaveConfig(config); err != nil {
			return fmt.Errorf("save config: %w", err)
		}
		cmd.Println("Dev mode disabled: using production Kavla servers.")
		return nil
	},
}

var viewConfigCmd = &cobra.Command{
	Use:   "view",
	Short: "View current configuration",
	Run: func(cmd *cobra.Command, args []string) {
		config, err := kavlaconfig.LoadConfig()
		if err != nil {
			if kavlaconfig.IsConfigMissing(err) {
				fmt.Println("No configuration found.")
			} else {
				fmt.Printf("Error loading config: %v\n", err)
			}
			return
		}
		if len(config.Sources) == 0 {
			fmt.Println("No data sources configured.")
			return
		}
		fmt.Println("Configured sources:")
		for name, source := range config.Sources {
			fmt.Printf("  - %s (%s)\n", name, source.Type)
		}
	},
}

func init() {
	setConfigCmd.AddCommand(setDevConfigCmd)
	unsetConfigCmd.AddCommand(unsetDevConfigCmd)
	configCmd.AddCommand(setConfigCmd, unsetConfigCmd)
	configCmd.AddCommand(viewConfigCmd)
	rootCmd.AddCommand(configCmd)
}
