package cmd

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"
)

var Version = "dev"
var Commit = ""
var BuildDate = ""

func formattedVersion() string {
	lines := []string{fmt.Sprintf("kavla %s", Version)}
	if strings.TrimSpace(Commit) != "" {
		lines = append(lines, fmt.Sprintf("commit: %s", Commit))
	}
	if strings.TrimSpace(BuildDate) != "" {
		lines = append(lines, fmt.Sprintf("built: %s", BuildDate))
	}
	return strings.Join(lines, "\n")
}

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Show version information",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Fprintln(cmd.OutOrStdout(), formattedVersion())
	},
}

func init() {
	rootCmd.Version = formattedVersion()
	rootCmd.SetVersionTemplate("{{.Version}}\n")
	rootCmd.AddCommand(versionCmd)
}
