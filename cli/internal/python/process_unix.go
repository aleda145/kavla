//go:build !windows

package python

import (
    "os/exec"
    "syscall"
)

func configureProcess(command *exec.Cmd) {
    command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
    command.Cancel = func() error { return syscall.Kill(-command.Process.Pid, syscall.SIGKILL) }
}
