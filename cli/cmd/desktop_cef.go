//go:build cef && (linux || darwin)

package cmd

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/aleda145/kavla/cli/internal/localapp"
)

// The CEF shell is a separate native process. Go retains ownership of the
// document, HTTP server, and save-on-close behavior.
func runDesktop(server *localapp.Server, launchURL, _ string, _ func(string, string)) (result error) {
	defer func() {
		fmt.Println("Saving Kavla document...")
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := server.Close(ctx); err != nil {
			result = errors.Join(result, fmt.Errorf("close Kavla document: %w", err))
			return
		}
		fmt.Println("Saved.")
	}()

	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate CEF desktop installation: %w", err)
	}
	cefBinary := cefExecutable(executable)
	cacheDir, err := os.UserCacheDir()
	if err != nil {
		return fmt.Errorf("locate CEF cache directory: %w", err)
	}
	// A separate profile per server avoids Chromium's singleton redirecting a
	// second document window to another process and closing its Go backend.
	profile, err := os.MkdirTemp("", "kavla-cef-profile-")
	if err != nil {
		return fmt.Errorf("create CEF profile: %w", err)
	}
	defer os.RemoveAll(profile)
	if err := os.MkdirAll(filepath.Join(cacheDir, "kavla", "cef"), 0700); err != nil {
		return fmt.Errorf("create CEF log directory: %w", err)
	}
	command := exec.Command(cefBinary,
		"--url="+launchURL,
		"--cache-path="+profile,
		"--log-file="+filepath.Join(cacheDir, "kavla", "cef", "chromium.log"),
	)
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	configureCEFCommand(command)

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	if err := command.Start(); err != nil {
		return fmt.Errorf("start CEF desktop shell: %w", err)
	}
	wait := make(chan error, 1)
	go func() { wait <- command.Wait() }()
	select {
	case err := <-wait:
		if err != nil {
			return fmt.Errorf("CEF desktop shell exited: %w", err)
		}
	case <-signals:
		_ = command.Process.Signal(syscall.SIGTERM)
		select {
		case <-wait:
		case <-time.After(10 * time.Second):
			_ = command.Process.Kill()
			<-wait
		}
	}
	return nil
}
