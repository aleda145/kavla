//go:build !linux && !darwin && !windows

package spilldir

import (
	"fmt"
	"os"
)

func lockFile(_ *os.File, _ bool) (bool, error) {
	return false, fmt.Errorf("DuckDB spill ownership is not supported on this platform")
}
