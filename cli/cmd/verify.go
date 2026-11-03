package cmd

import (
	"fmt"

	"github.com/aleda145/kavla/cli/internal/localapp"
	"github.com/spf13/cobra"
)

var verifyCmd = &cobra.Command{
	Use:   "verify <file.kavla>",
	Short: "Verify all uploaded file and asset checksums without extraction",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		count, err := localapp.VerifyDocument(args[0])
		if err != nil {
			return err
		}
		fmt.Fprintf(cmd.OutOrStdout(), "Verified %d files in %s.\n", count, args[0])
		return nil
	},
}

func init() { rootCmd.AddCommand(verifyCmd) }
