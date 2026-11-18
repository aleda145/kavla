//go:build linux || darwin

package cmd

import (
	"os/exec"
	"syscall"
)

func detachExternalBrowser(command *exec.Cmd) {
	// Keep the browser and its children outside the terminal's session so
	// Ctrl+C in Kavla cannot also interrupt a newly launched browser.
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
