package cmd

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/aleda145/kavla/cli/internal/updater"
	"github.com/spf13/cobra"
)

var updateCmd = &cobra.Command{
	Use:     "update",
	Aliases: []string{"upgrade"},
	Short:   "Update the Kavla CLI",
	Args:    cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		ctx := cmd.Context()
		if ctx == nil {
			ctx = context.Background()
		}

		updateCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()

		result, err := updater.New().Update(updateCtx, Version)
		if err != nil {
			switch {
			case errors.Is(err, updater.ErrSourceBuild):
				return fmt.Errorf("kavla update is unavailable for source builds")
			case errors.Is(err, updater.ErrUnsupportedPlatform):
				return fmt.Errorf("update is unavailable: %w", err)
			case errors.Is(err, updater.ErrManualInstallRequired):
				return fmt.Errorf("update failed; reinstall Kavla manually: %w", err)
			default:
				return fmt.Errorf("update failed: %w", err)
			}
		}

		if !result.Updated {
			fmt.Fprintln(cmd.OutOrStdout(), "kavla is already up to date")
			return nil
		}

		fmt.Fprintf(cmd.OutOrStdout(), "Updated kavla from %s to %s\n", result.PreviousVersion, result.NewVersion)
		if result.NotesURL != "" {
			fmt.Fprintf(cmd.OutOrStdout(), "Release notes: %s\n", result.NotesURL)
		}
		return nil
	},
}

func init() {
	rootCmd.AddCommand(updateCmd)
}
