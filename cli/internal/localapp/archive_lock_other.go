//go:build !linux && !darwin && !windows

package localapp

import (
	"fmt"
	"os"
)

func lockArchiveFile(_ *os.File, _ bool) (bool, error) {
	return false, fmt.Errorf("Archive locking is not supported on this platform")
}

func syncArchiveDirectory(_ string) error { return nil }
