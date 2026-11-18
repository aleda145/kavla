//go:build !cef || (!linux && !darwin && !windows)

package cmd

import "github.com/aleda145/kavla/cli/internal/localapp"

const defaultRunBrowser = browserPrompt

// A regular Go build retains the original CLI/browser development workflow.
// CEF builds select desktop_cef.go on Linux, macOS and Windows.
func runDesktop(server *localapp.Server, launchURL, _ string, _ func(string, string)) error {
	return runBrowserServer(server, launchURL, browserAutomatic)
}
