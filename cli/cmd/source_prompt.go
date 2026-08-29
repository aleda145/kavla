package cmd

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

var errPromptCancelled = errors.New("cancelled")

type terminalSourcePrompter struct {
	reader *bufio.Reader
}

func newTerminalSourcePrompter() *terminalSourcePrompter {
	return &terminalSourcePrompter{reader: bufio.NewReader(os.Stdin)}
}

func (p *terminalSourcePrompter) Select(label string, options []sourcePromptOption) (string, error) {
	interactiveOptions := make([]string, 0, len(options))
	for _, option := range options {
		interactiveOptions = append(interactiveOptions, option.Label)
	}

	selected, err := chooseOptionInteractive(label, interactiveOptions)
	if err == nil {
		if selected < 0 {
			return "", errPromptCancelled
		}
		return options[selected].Value, nil
	}
	if !errors.Is(err, errInteractiveSelectionUnavailable) {
		return "", err
	}

	fmt.Printf("%s\n", label)
	for i, option := range options {
		if strings.EqualFold(option.Label, option.Value) {
			fmt.Printf("  %d. %s\n", i+1, option.Label)
		} else {
			fmt.Printf("  %d. %s (%s)\n", i+1, option.Label, option.Value)
		}
	}

	for {
		answer, err := p.readLine("Enter choice", "Type the number or source key")
		if err != nil {
			return "", err
		}

		for i, option := range options {
			if answer == strconv.Itoa(i+1) || strings.EqualFold(answer, option.Value) || strings.EqualFold(answer, option.Label) {
				return option.Value, nil
			}
		}

		fmt.Printf("Invalid choice. Enter a number or one of: %s\n", strings.Join(sourcePromptValues(options), ", "))
	}
}

func (p *terminalSourcePrompter) Input(label, help string) (string, error) {
	return p.readLine(label, help)
}

func (p *terminalSourcePrompter) readLine(label, help string) (string, error) {
	if help != "" {
		fmt.Printf("%s\n", help)
	}
	fmt.Printf("%s: ", label)

	line, err := p.reader.ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}

	value := strings.TrimSpace(line)
	if errors.Is(err, io.EOF) && value == "" {
		return "", errPromptCancelled
	}

	return value, nil
}

func sourcePromptValues(options []sourcePromptOption) []string {
	values := make([]string, 0, len(options))
	for _, option := range options {
		values = append(values, option.Value)
	}
	return values
}
