// Package memoryguard installs the compute worker's operating system memory
// boundary before it initializes native database libraries.
package memoryguard

import (
	"sync"
	"sync/atomic"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
)

var initialize sync.Once
var initializeError error
var limitBytes atomic.Uint64
var duckDBBytes atomic.Uint64

// Enable is process-wide. Platform implementations must verify enforcement
// before publishing a limit; a Go GC limit cannot contain native allocations.
// A zero limit means this platform does not implement enforcement yet.
func Enable(settings kavlaconfig.MemorySettings) (uint64, error) {
	if err := settings.Validate(); err != nil {
		return 0, err
	}
	initialize.Do(func() {
		limit, err := enable(settings)
		initializeError = err
		if err == nil {
			limitBytes.Store(limit)
			percent := uint64(settings.DuckDBPercentOfLimit)
			duckDBBytes.Store(limit/100*percent + limit%100*percent/100)
		}
	})
	return limitBytes.Load(), initializeError
}

// DuckDBLimit leaves headroom inside the hard boundary for native allocations
// outside DuckDB's buffer manager, Arrow results, and the worker's Go runtime.
// This is only a cooperative per-engine limit; the OS enforces the shared cap.
func DuckDBLimit() uint64 {
	return duckDBBytes.Load()
}
