//go:build cef && darwin

package cmd

import (
	"os"
	"os/exec"
	"path/filepath"
)

func init() {
	// Finder launches the app bundle executable without CLI arguments.
	if len(os.Args) == 1 {
		os.Args = append(os.Args, "run")
	}
}

func cefExecutable(executable string) string {
	return filepath.Join(filepath.Dir(executable), "kavla-cef")
}

func configureCEFCommand(command *exec.Cmd) {
	// macOS has no parent-death signal; normal shutdown forwards SIGTERM.
}
