// Package memoryguard installs the compute worker's operating system memory
// boundary before it initializes native database libraries.
package memoryguard

import (
	"sync"
	"sync/atomic"
)

var initialize sync.Once
var initializeError error
var limitBytes atomic.Uint64

// Enable is process-wide. Platform implementations must verify enforcement
// before publishing a limit; a Go GC limit cannot contain native allocations.
// A zero limit means this platform does not implement enforcement yet.
func Enable() (uint64, error) {
	initialize.Do(func() {
		limit, err := enable()
		initializeError = err
		if err == nil {
			limitBytes.Store(limit)
		}
	})
	return limitBytes.Load(), initializeError
}

// DuckDBLimit leaves headroom inside the hard boundary for native allocations
// outside DuckDB's buffer manager, Arrow results, and the worker's Go runtime.
// This is only a cooperative per-engine limit; the OS enforces the shared cap.
func DuckDBLimit() uint64 {
	return limitBytes.Load() / 2
}
