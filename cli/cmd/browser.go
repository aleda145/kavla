//go:build !production && !dev

package cmd

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/aleda145/kavla/cli/internal/localapp"
)

func openBrowser(url string) error {
	return openExternalBrowser(url)
}

// A regular Go build retains the original CLI/browser development workflow.
// Wails builds select desktop.go through their production or dev build tag.
func runDesktop(server *localapp.Server, launchURL, _ string, _ func(string, string)) error {
	if err := openBrowser(launchURL); err != nil {
		fmt.Printf("Could not open the browser automatically. Open this URL:\n%s\n", launchURL)
	}
	fmt.Println("Press Ctrl+C to save and close Kavla.")

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	<-signals

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	fmt.Println("Saving Kavla document...")
	if err := server.Close(ctx); err != nil {
		return fmt.Errorf("close Kavla document: %w", err)
	}
	fmt.Println("Saved.")
	return nil
}
