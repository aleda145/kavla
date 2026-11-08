//go:build !linux

package memoryguard

import kavlaconfig "github.com/aleda145/kavla/cli/internal/config"

// Keep existing platforms working without claiming Linux's hard guarantee.
// Windows and macOS need their own native enforcement implementations here.
func enable(_ kavlaconfig.MemorySettings) (uint64, error) {
	return 0, nil
}

func fallbackBudget(_ int) (uint64, uint64, error) {
	return 0, 0, nil
}
