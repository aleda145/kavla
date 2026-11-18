package cmd

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/aleda145/kavla/cli/internal/localapp"
	"golang.org/x/term"
)

type browserMode int

const (
	browserDisabled browserMode = iota
	browserPrompt
	browserAutomatic
)

func runBrowserServer(server *localapp.Server, launchURL string, browser browserMode) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	fmt.Println("Press Ctrl+C to save and close Kavla.")

	if browser == browserAutomatic || (browser == browserPrompt && confirmBrowserLaunch(ctx, server.BrowserConnected())) {
		if err := openExternalBrowser(launchURL); err != nil {
			fmt.Printf("Could not launch the browser: %v. Open this URL:\n%s\n", err, launchURL)
		}
	}

	<-ctx.Done()
	shutdown, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	fmt.Println("Saving Kavla document...")
	if err := server.Close(shutdown); err != nil {
		return fmt.Errorf("close Kavla document: %w", err)
	}
	fmt.Println("Saved.")
	return nil
}

func confirmBrowserLaunch(ctx context.Context, connected <-chan struct{}) bool {
	if !term.IsTerminal(int(os.Stdin.Fd())) || !term.IsTerminal(int(os.Stdout.Fd())) {
		return false
	}
	select {
	case <-connected:
		return false
	case <-ctx.Done():
		return false
	default:
	}

	fmt.Print("Launch browser? [Y/n] ")
	// Keep normal terminal input so Ctrl+C still interrupts Kavla. The read
	// can finish after the prompt is dismissed, so its result is buffered.
	answer := make(chan bool, 1)
	go func() {
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		choice := strings.ToLower(strings.TrimSpace(line))
		answer <- err == nil && (choice == "" || choice == "y" || choice == "yes")
	}()

	select {
	case <-connected:
		fmt.Print("\r\x1b[2KBrowser connected.\n")
		return false
	case <-ctx.Done():
		fmt.Println()
		return false
	case launch := <-answer:
		select {
		case <-connected:
			fmt.Println("Browser connected.")
			return false
		case <-ctx.Done():
			return false
		default:
			return launch
		}
	}
}
