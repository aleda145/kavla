package cmd

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

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
			fmt.Fprintf(os.Stderr, "Update check failed: %v\n", err)
		}
		return
	}
	if result.ShouldNotify {
		fmt.Fprintf(os.Stderr, "A new Kavla version is available: %s (current: %s). Run: kavla update\n", result.LatestVersion, result.CurrentVersion)
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
	return name != "help" && name != "version" && name != "update" && name != "upgrade" && !strings.HasPrefix(name, "__complete")
}

func init() {
	rootCmd.PersistentFlags().BoolVarP(&verbose, "verbose", "v", false, "Enable verbose log output")
}
