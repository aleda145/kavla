//go:build cef && windows

package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

func init() {
	// Explorer launches the desktop executable without CLI arguments.
	if len(os.Args) == 1 {
		os.Args = append(os.Args, "run")
	} else if len(os.Args) == 2 && strings.EqualFold(filepath.Ext(os.Args[1]), ".kavla") {
		os.Args = []string{os.Args[0], "open", os.Args[1]}
	}
}

func cefExecutable(executable string) string {
	return filepath.Join(filepath.Dir(executable), "cef", "kavla-desktop.exe")
}

func configureCEFCommand(command *exec.Cmd) error {
	// ZIP archives do not preserve the read/execute ACL required by CEF's
	// sandboxed processes. Grant it on the bundled runtime after extraction.
	acl := exec.Command("icacls.exe", filepath.Dir(command.Path), "/grant", "*S-1-15-2-2:(OI)(CI)(RX)")
	acl.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if output, err := acl.CombinedOutput(); err != nil {
		return fmt.Errorf("configure CEF sandbox permissions: %w: %s", err, output)
	}
	// The Go backend handles Ctrl+C and saves the document before exiting.
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP}
	return nil
}
