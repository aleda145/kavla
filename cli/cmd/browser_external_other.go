//go:build !linux && !darwin

package cmd

import "os/exec"

func detachExternalBrowser(command *exec.Cmd) {}
