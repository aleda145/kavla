package cmd

import (
	"errors"
	"fmt"
	"os"

	"golang.org/x/term"
)

var errInteractiveSelectionUnavailable = errors.New("interactive selection unavailable")

const pageSize = 10

func chooseOptionInteractive(title string, options []string) (int, error) {
	if len(options) == 0 {
		return -1, nil
	}

	oldState, err := term.MakeRaw(int(os.Stdin.Fd()))
	if err != nil {
		return -1, errInteractiveSelectionUnavailable
	}
	defer term.Restore(int(os.Stdin.Fd()), oldState)

	selected := 0
	scrollOffset := 0
	buf := make([]byte, 3)
	lastRenderedLines := 0

	for {
		if selected < scrollOffset {
			scrollOffset = selected
		}
		if selected >= scrollOffset+pageSize {
			scrollOffset = selected - pageSize + 1
		}

		hasMore := len(options) > pageSize
		showUpIndicator := hasMore && scrollOffset > 0
		showDownIndicator := hasMore && scrollOffset+pageSize < len(options)

		if lastRenderedLines > 0 {
			for i := 0; i < lastRenderedLines; i++ {
				fmt.Print("\033[A\033[2K")
			}
		}

		lineCount := 0
		fmt.Print("\r\033[J")
		fmt.Printf("\033[1m  %s\033[0m", title)
		if hasMore {
			fmt.Printf("  \033[2m(%d/%d)\033[0m", selected+1, len(options))
		}
		fmt.Print("\r\n\r\n")
		lineCount += 2

		if showUpIndicator {
			fmt.Print("  \033[2m  more above\033[0m\r\n")
			lineCount++
		}

		end := scrollOffset + pageSize
		if end > len(options) {
			end = len(options)
		}
		for i := scrollOffset; i < end; i++ {
			if i == selected {
				fmt.Printf("  \033[1m\033[43m\033[30m > %s \033[0m\r\n", options[i])
			} else {
				fmt.Printf("    %s\r\n", options[i])
			}
			lineCount++
		}

		if showDownIndicator {
			fmt.Print("  \033[2m  more below\033[0m\r\n")
			lineCount++
		}

		fmt.Print("\r\n  \033[2mup/down navigate | enter select | q quit\033[0m")
		lineCount++
		lastRenderedLines = lineCount

		n, err := os.Stdin.Read(buf)
		if err != nil {
			return -1, err
		}

		if n == 1 {
			switch buf[0] {
			case 13:
				clearInteractiveSelection(lastRenderedLines)
				return selected, nil
			case 'q', 3:
				clearInteractiveSelection(lastRenderedLines)
				return -1, nil
			case 'k':
				if selected > 0 {
					selected--
				}
			case 'j':
				if selected < len(options)-1 {
					selected++
				}
			}
		} else if n == 3 && buf[0] == 27 && buf[1] == 91 {
			switch buf[2] {
			case 65:
				if selected > 0 {
					selected--
				}
			case 66:
				if selected < len(options)-1 {
					selected++
				}
			}
		}
	}
}

func clearInteractiveSelection(lines int) {
	fmt.Print("\033[2K")
	for i := 0; i < lines; i++ {
		fmt.Print("\033[A\033[2K")
	}
	fmt.Print("\r")
}
