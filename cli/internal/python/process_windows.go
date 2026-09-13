//go:build windows

package python

import ("os/exec"; "fmt")

func configureProcess(command *exec.Cmd) {
    command.Cancel = func() error { return exec.Command("taskkill", "/T", "/F", "/PID", fmt.Sprint(command.Process.Pid)).Run() }
}
