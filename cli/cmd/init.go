package cmd

import (
	"fmt"
	"os"
	"strings"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

type initPrompter interface {
	Confirm(label string) (bool, error)
}

type terminalInitPrompter struct{}

func (terminalInitPrompter) Confirm(label string) (bool, error) {
	oldState, err := term.MakeRaw(int(os.Stdin.Fd()))
	if err != nil {
		return false, err
	}
	defer term.Restore(int(os.Stdin.Fd()), oldState)
	fmt.Printf("%s [Y/n]: ", label)
	buffer := make([]byte, 1)
	for {
		count, err := os.Stdin.Read(buffer)
		if err != nil {
			fmt.Print("\r\n")
			return false, err
		}
		if count != 1 {
			continue
		}
		switch buffer[0] {
		case '\r', '\n', 'y', 'Y':
			fmt.Print("\r\n")
			return true, nil
		case 'n', 'N':
			fmt.Print("\r\n")
			return false, nil
		case 3:
			fmt.Print("\r\n")
			return false, fmt.Errorf("setup cancelled")
		}
	}
}

var initCmd = &cobra.Command{
	Use:   "init",
	Short: "Set up CLI sources and Kavla.dev access",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		if !term.IsTerminal(int(os.Stdin.Fd())) || !term.IsTerminal(int(os.Stdout.Fd())) {
			return fmt.Errorf("kavla init must be run in a terminal")
		}
		prompter := terminalInitPrompter{}
		fmt.Println("Kavla CLI setup")
		fmt.Println()
		setupSource, err := prompter.Confirm("Set up a data source?")
		if err != nil {
			return err
		}
		if setupSource {
			if err := runAddSourceWithPrompter(newTerminalSourcePrompter(), true); err != nil {
				return err
			}
		}

		loginNow, err := prompter.Confirm("Log in to Kavla.dev?")
		if err != nil {
			return err
		}
		if loginNow {
			if err := runLogin(cmd.Context()); err != nil {
				return err
			}
		}

		config, err := kavlaconfig.LoadConfigAllowMissing()
		if err != nil {
			return fmt.Errorf("load config: %w", err)
		}
		if strings.TrimSpace(config.Token) == "" {
			return nil
		}
		connectNow, err := prompter.Confirm("Connect to a Kavla.dev canvas now?")
		if err != nil {
			return err
		}
		if connectNow {
			return runConnect(nil)
		}
		return nil
	},
}

func init() {
	initCmd.Flags().StringVar(&sourceName, "name", "", "Name of the source")
	initCmd.Flags().StringVar(&sourceType, "type", "", "Type of source")
	initCmd.Flags().StringVar(&sourceConnection, "connection", "", "Connection string, file path, or project ID")
	rootCmd.AddCommand(initCmd)
}
