package cmd

import (
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/aleda145/kavla/cli/internal/auth"
	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
	"github.com/aleda145/kavla/cli/internal/transport"
	"github.com/spf13/cobra"
)

var connectURL string

var connectCmd = &cobra.Command{
	Use:   "connect [CANVAS_ID]",
	Short: "Connect CLI sources to a Kavla.dev canvas",
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		return runConnect(args)
	},
}

func runConnect(args []string) error {
	config, err := kavlaconfig.LoadConfigAllowMissing()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	if strings.TrimSpace(config.Token) == "" {
		return fmt.Errorf("not logged in; run 'kavla login' first")
	}
	authURL := firstNonEmpty(config.AuthURL, auth.DefaultAuthURL)
	validation, err := auth.ValidateToken(authURL, config.Token)
	if err != nil {
		return fmt.Errorf("login is invalid or expired; run 'kavla login' again")
	}
	if validation.Token != config.Token {
		config.Token = validation.Token
		if err := kavlaconfig.SaveConfig(config); err != nil {
			return fmt.Errorf("save refreshed login: %w", err)
		}
	}

	roomID := ""
	roomName := ""
	if len(args) == 1 {
		roomID = strings.TrimSpace(args[0])
		if roomID == "" {
			return fmt.Errorf("canvas ID cannot be empty")
		}
	} else {
		fmt.Println("Fetching your Kavla.dev canvases...")
		rooms, err := fetchRooms(authURL, config.Token)
		if err != nil {
			return err
		}
		if len(rooms) == 0 {
			return fmt.Errorf("no canvases found; create one at app.kavla.dev first")
		}
		selected := pickRoom(rooms)
		if selected < 0 {
			return fmt.Errorf("connection cancelled")
		}
		roomID = rooms[selected].ID
		roomName = rooms[selected].Name
	}

	fmt.Print("Checking canvas ownership... ")
	if err := checkRoomOwnership(authURL, config.Token, roomID, validation.User.ID); err != nil {
		return fmt.Errorf("\n%w", err)
	}
	fmt.Println("OK")
	if roomName != "" {
		fmt.Printf("Connecting CLI sources to %q...\n", roomName)
	} else {
		fmt.Printf("Connecting CLI sources to %s...\n", roomID)
	}

	apiURL := firstNonEmpty(connectURL, config.APIURL, auth.DefaultAPIURL)
	manager := transport.NewManager(apiURL, roomID, config.Token, config.Sources, verbose)
	if err := manager.Prepare(); err != nil {
		return err
	}
	if err := manager.Start(); err != nil {
		manager.Stop(transport.DisconnectReasonLocalShutdown, nil)
		return fmt.Errorf("connect to Kavla.dev: %w", err)
	}

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	select {
	case <-signals:
		manager.Stop(transport.DisconnectReasonLocalShutdown, nil)
	case event := <-manager.Done:
		switch event.Reason {
		case transport.DisconnectReasonRemoteClose:
			return fmt.Errorf("Kavla.dev closed the connection: %w", event.Err)
		case transport.DisconnectReasonReadError:
			return fmt.Errorf("Kavla.dev connection failed: %w", event.Err)
		}
	}
	return nil
}

func init() {
	connectCmd.Flags().StringVar(&connectURL, "url", "", "Kavla app API URL")
	rootCmd.AddCommand(connectCmd)
}
