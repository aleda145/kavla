package cmd

import (
	"fmt"

	"github.com/aleda145/kavla/cli/internal/localapp"
	"github.com/spf13/cobra"
)

var compactCmd = &cobra.Command{
	Use:   "compact <file.kavla>",
	Short: "Reclaim obsolete revisions and deleted data from a Kavla file",
	Long:  "Rewrite a Kavla file with only its current entries. Close the canvas first. This reads and writes its live uploads once; history remains available and retains its own data until it expires.",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		before, after, err := localapp.CompactDocument(args[0])
		if err != nil {
			return err
		}
		fmt.Fprintf(cmd.OutOrStdout(), "Compacted %s: %d → %d bytes. History revisions are retained.\n", args[0], before, after)
		return nil
	},
}

func init() { rootCmd.AddCommand(compactCmd) }
