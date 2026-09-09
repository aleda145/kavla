//go:build cef && linux

package cmd

import (
	"os/exec"
	"path/filepath"
	"syscall"
)

func cefExecutable(executable string) string {
	return filepath.Join(filepath.Dir(executable), "..", "lib", "kavla-cef", "kavla-cef")
}

func configureCEFCommand(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGTERM}
}
