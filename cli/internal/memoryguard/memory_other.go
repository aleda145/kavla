//go:build !linux

package memoryguard

// Keep existing platforms working without claiming Linux's hard guarantee.
// Windows and macOS need their own native enforcement implementations here.
func enable() (uint64, error) {
	return 0, nil
}
