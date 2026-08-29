package cmd

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
	"github.com/aleda145/kavla/cli/internal/localapp"
	"github.com/aleda145/kavla/cli/internal/webapp"
	"github.com/spf13/cobra"
)

var noBrowser bool
var openHost string
var openPort int

var openCmd = &cobra.Command{
	Use:   "open FILE.kavla",
	Short: "Open a local Kavla document",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		return runOpen(args[0], noBrowser, openHost, openPort, shouldFallbackFromDefaultPort(cmd, openPort))
	},
}

func runOpen(documentPath string, skipBrowser bool, host string, port int, fallbackFromDefaultPort bool) error {
	return runDocument(documentPath, skipBrowser, "Opening", host, port, fallbackFromDefaultPort)
}

func runDocument(documentPath string, skipBrowser bool, action, host string, port int, fallbackFromDefaultPort bool) error {
	if err := ensureBundledTitanicSource(); err != nil {
		return err
	}
	document, err := localapp.OpenDocument(documentPath)
	if err != nil {
		return err
	}
	documentOwnedByServer := false
	defer func() {
		if !documentOwnedByServer {
			_ = document.CleanupWorkingCopy()
		}
	}()
	config, err := kavlaconfig.LoadConfigAllowMissing()
	if err != nil {
		return fmt.Errorf("load Kavla source configuration: %w", err)
	}
	assets, err := webapp.Files()
	if err != nil {
		return err
	}
	server, err := localapp.NewServer(document, assets, config.Sources, verbose)
	if err != nil {
		return err
	}
	documentOwnedByServer = true
	launchURL, err := server.Start(host, port, fallbackFromDefaultPort)
	if err != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = server.Close(ctx)
		return err
	}
	rememberDocument := func(_ string, activeDocumentPath string) {
		if err := kavlaconfig.RememberDocumentPath(activeDocumentPath); err != nil {
			fmt.Fprintf(os.Stderr, "Could not remember the open Kavla document: %v\n", err)
		}
	}
	server.SetDocumentChangeHandler(rememberDocument)
	rememberDocument(document.Manifest().DocumentName, document.Path())

	fmt.Printf("%s %s\n", action, document.Path())
	fmt.Printf("Kavla is ready at %s\n", launchURL)
	if !skipBrowser {
		return runDesktop(server, launchURL, document.Manifest().DocumentName, rememberDocument)
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

func init() {
	openCmd.Flags().BoolVar(&noBrowser, "no-browser", false, "Run headlessly and print the server URL")
	openCmd.Flags().StringVar(&openHost, "host", defaultServerHost, "Address to listen on (use 0.0.0.0 for remote access)")
	openCmd.Flags().IntVar(&openPort, "port", defaultServerPort, "HTTP port to listen on (chooses another if the default is busy)")
	rootCmd.AddCommand(openCmd)
}
