package cmd

import (
	"context"
	"log"
	"os"
	"strings"
	"time"

	"github.com/aleda145/kavla/cli/internal/logging"
	"github.com/aleda145/kavla/cli/internal/updater"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

var verbose bool

var rootCmd = &cobra.Command{
	Use:   "kavla",
	Short: "Kavla - an infinite canvas for exploratory analytics",
	Long: `Kavla opens local .kavla documents and connects configured data sources
to either the local canvas or a canvas on Kavla.dev. Database credentials are
stored in the CLI config, not in .kavla documents or the hosted canvas.`,
	SilenceUsage: true,
}

func Execute() {
	logging.ConfigureStandardLogger()
	executedCommand, err := rootCmd.ExecuteC()
	if err != nil {
		os.Exit(1)
	}
	maybeNotifyAboutUpdate(executedCommand)
}

func maybeNotifyAboutUpdate(command *cobra.Command) {
	if !shouldCheckForUpdates(command) {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	result, err := updater.New().Check(ctx, Version)
	if err != nil {
		if verbose {
			log.Printf("Update check failed: %v", err)
		}
		return
	}
	if result.ShouldNotify {
		log.Printf("A new Kavla version is available: %s (current: %s). View releases to update manually: %s", result.LatestVersion, result.CurrentVersion, updater.ReleasesURL)
	}
}

func shouldCheckForUpdates(command *cobra.Command) bool {
	if command == nil || command == rootCmd || os.Getenv("KAVLA_NO_UPDATE_CHECK") == "1" {
		return false
	}
	if !updater.IsManagedVersion(Version) || !term.IsTerminal(int(os.Stderr.Fd())) {
		return false
	}
	name := strings.TrimSpace(command.Name())
	return name != "help" && name != "version" && name != "update" && name != "upgrade" && name != "run" && name != "open" && !strings.HasPrefix(name, "__complete")
}

func init() {
	rootCmd.PersistentFlags().BoolVarP(&verbose, "verbose", "v", false, "Enable verbose log output")
}
