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
	configCmd.AddCommand(viewConfigCmd)
	rootCmd.AddCommand(configCmd)
}
