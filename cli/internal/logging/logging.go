package logging

import (
	"log"
	"os"
	"strings"
	"time"
)

var lineBreaks = strings.NewReplacer("\r", `\r`, "\n", `\n`)

// Entry keeps multiline messages together under one UTC timestamp.
func Entry(at time.Time, message string) string {
	// The output sink supplies the final newline. Preserve deliberate blank lines.
	message = strings.TrimSuffix(strings.TrimSuffix(message, "\n"), "\r")
	return at.UTC().Format("2006-01-02T15:04:05.000Z07:00") + " " + message
}

// ConfigureStandardLogger also formats messages from net/http's default logger.
func ConfigureStandardLogger() {
	log.SetFlags(0)
	log.SetOutput(stderrLogger{})
}

type stderrLogger struct{}

func (stderrLogger) Write(p []byte) (int, error) {
	message := lineBreaks.Replace(strings.TrimRight(string(p), "\r\n"))
	_, err := os.Stderr.WriteString(Entry(time.Now(), message) + "\n")
	if err != nil {
		return 0, err
	}
	return len(p), nil
}
