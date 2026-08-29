package cmd

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/aleda145/kavla/cli/internal/auth"
	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
	"github.com/spf13/cobra"
)

var loginURL string

const loginCallbackHTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Kavla CLI</title></head>
<body style="font-family:system-ui,sans-serif;background:#f8f7f4;display:grid;place-items:center;min-height:100vh;margin:0">
<main style="background:white;border:3px solid black;border-radius:14px;padding:32px;text-align:center"><h1>CLI connected</h1><p>You can close this tab and return to the terminal.</p></main>
</body></html>`

var loginCmd = &cobra.Command{
	Use:   "login",
	Short: "Log in to Kavla.dev",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		return runLogin(cmd.Context())
	},
}

func runLogin(parent context.Context) error {
	config, err := kavlaconfig.LoadConfigAllowMissing()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	appURL := firstNonEmpty(loginURL, config.AppURL, auth.DefaultAppURL)
	authURL := firstNonEmpty(config.AuthURL, auth.DefaultAuthURL)
	expectedOrigin, err := originForURL(appURL)
	if err != nil {
		return fmt.Errorf("invalid Kavla app URL: %w", err)
	}
	state, err := newLoginState()
	if err != nil {
		return fmt.Errorf("create login state: %w", err)
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("start login callback: %w", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	tokenResult := make(chan string, 1)
	serverError := make(chan error, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Origin") != expectedOrigin {
			http.Error(writer, "Forbidden origin", http.StatusForbidden)
			return
		}
		if request.URL.Query().Get("state") != state {
			http.Error(writer, "Invalid login state", http.StatusForbidden)
			return
		}
		writer.Header().Set("Access-Control-Allow-Origin", expectedOrigin)
		writer.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		writer.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if request.Method == http.MethodOptions {
			writer.WriteHeader(http.StatusNoContent)
			return
		}
		if request.Method != http.MethodPost {
			http.Error(writer, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		request.Body = http.MaxBytesReader(writer, request.Body, 64<<10)
		var body struct {
			Token string `json:"token"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil || strings.TrimSpace(body.Token) == "" {
			http.Error(writer, "Invalid login response", http.StatusBadRequest)
			return
		}
		writer.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = fmt.Fprint(writer, loginCallbackHTML)
		select {
		case tokenResult <- body.Token:
		default:
		}
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			serverError <- err
		}
	}()
	defer func() {
		shutdownContext, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownContext)
	}()

	loginPage, err := loginPageURL(appURL, port, state)
	if err != nil {
		return err
	}
	fmt.Println("Opening Kavla.dev for authentication...")
	fmt.Printf("If the browser does not open, visit:\n%s\n", loginPage)
	if err := openExternalBrowser(loginPage); err != nil {
		fmt.Printf("Could not open the browser automatically: %v\n", err)
	}
	fmt.Println("Waiting for authentication... (Ctrl+C to cancel)")

	loginContext, stop := signal.NotifyContext(parent, os.Interrupt, syscall.SIGTERM)
	defer stop()
	timer := time.NewTimer(2 * time.Minute)
	defer timer.Stop()
	var token string
	select {
	case token = <-tokenResult:
	case err := <-serverError:
		return fmt.Errorf("login callback failed: %w", err)
	case <-timer.C:
		return fmt.Errorf("login timed out; run 'kavla login' to try again")
	case <-loginContext.Done():
		return fmt.Errorf("login cancelled")
	}

	validation, err := auth.ValidateToken(authURL, token)
	if err != nil {
		return fmt.Errorf("validate login: %w", err)
	}
	if err := auth.SaveToken(validation.Token); err != nil {
		return fmt.Errorf("save login: %w", err)
	}
	fmt.Printf("Logged in as %s.\n", displayUser(validation.User.Name, validation.User.Email))
	return nil
}

func newLoginState() (string, error) {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}

func originForURL(rawURL string) (string, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return "", err
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("URL must use http or https")
	}
	if parsed.Host == "" {
		return "", fmt.Errorf("URL has no host")
	}
	return parsed.Scheme + "://" + parsed.Host, nil
}

func loginPageURL(appURL string, port int, state string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(appURL))
	if err != nil {
		return "", fmt.Errorf("create login URL: %w", err)
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/auth"
	query := parsed.Query()
	query.Set("mode", "login")
	query.Set("cli_port", fmt.Sprintf("%d", port))
	query.Set("cli_state", state)
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimRight(strings.TrimSpace(value), "/")
		}
	}
	return ""
}

func displayUser(name, email string) string {
	name = strings.TrimSpace(name)
	email = strings.TrimSpace(email)
	if name != "" && email != "" {
		return name + " (" + email + ")"
	}
	if name != "" {
		return name
	}
	return email
}

func init() {
	loginCmd.Flags().StringVar(&loginURL, "url", "", "Kavla app URL")
	rootCmd.AddCommand(loginCmd)
}
