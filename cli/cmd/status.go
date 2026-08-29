package cmd

import (
	"fmt"
	"math"
	"time"

	"github.com/aleda145/kavla/cli/internal/auth"
	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
	"github.com/spf13/cobra"
)

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show Kavla.dev login and local source status",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		config, err := kavlaconfig.LoadConfigAllowMissing()
		if err != nil {
			return fmt.Errorf("load config: %w", err)
		}
		if config.Token == "" {
			fmt.Println("Not logged in to Kavla.dev. Run 'kavla login' to authenticate.")
			printConfiguredSources(config)
			return nil
		}

		authURL := firstNonEmpty(config.AuthURL, auth.DefaultAuthURL)
		validation, err := auth.ValidateToken(authURL, config.Token)
		if err != nil {
			return fmt.Errorf("login is invalid or expired; run 'kavla login' again")
		}
		if validation.Token != config.Token {
			config.Token = validation.Token
			if err := kavlaconfig.SaveConfig(config); err != nil {
				return fmt.Errorf("save refreshed login: %w", err)
			}
		}
		fmt.Printf("Logged in to Kavla.dev as %s.\n", displayUser(validation.User.Name, validation.User.Email))
		if expiry, err := auth.GetTokenExpiry(validation.Token); err == nil {
			fmt.Printf("Login expires in %s.\n", formatDuration(time.Until(expiry)))
		}
		printConfiguredSources(config)
		return nil
	},
}

func printConfiguredSources(config *kavlaconfig.Config) {
	if len(config.Sources) == 0 {
		fmt.Println("No CLI sources configured.")
		return
	}
	fmt.Println("Configured CLI sources:")
	for name, source := range config.Sources {
		fmt.Printf("  - %s (%s)\n", name, source.Type)
	}
}

func formatDuration(duration time.Duration) string {
	if duration < 0 {
		return "an expired amount of time"
	}
	if duration < time.Hour {
		return fmt.Sprintf("%d minutes", int(math.Round(duration.Minutes())))
	}
	if duration < 24*time.Hour {
		return fmt.Sprintf("%.0f hours", duration.Hours())
	}
	return fmt.Sprintf("%.0f days", duration.Hours()/24)
}

func init() {
	rootCmd.AddCommand(statusCmd)
}
