package cmd

import (
	"fmt"

	"github.com/aleda145/kavla/cli/internal/auth"
	"github.com/spf13/cobra"
)

var logoutCmd = &cobra.Command{
	Use:   "logout",
	Short: "Log out of Kavla.dev",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := auth.SaveToken(""); err != nil {
			return fmt.Errorf("clear login: %w", err)
		}
		fmt.Println("Logged out of Kavla.dev.")
		return nil
	},
}

func init() {
	rootCmd.AddCommand(logoutCmd)
}
