// Package memoryguard installs the compute worker's operating system memory
// boundary before it initializes native database libraries.
package memoryguard

import (
	"fmt"
	"sync"
	"sync/atomic"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
)

var initialize sync.Once
var initializeError error
var status Status
var duckDBBytes atomic.Uint64

// Status distinguishes a verified compute-only boundary from a cooperative
// DuckDB budget and an inherited boundary that may also contain the server.
type Status struct {
	Configured     bool
	Limit          uint64
	DuckDBLimit    uint64
	InheritedLimit uint64
	Warning        string
}

// Enable is process-wide. Only publish Limit after verifying enforcement;
// neither a Go GC limit nor DuckDB's buffer budget contains native allocations.
func Enable(settings kavlaconfig.MemorySettings) (Status, error) {
	if err := settings.Validate(); err != nil {
		return Status{}, err
	}
	initialize.Do(func() {
		status.Configured = settings.Configured
		if !settings.Configured {
			return
		}
		var budget uint64
		if settings.Enforcement == "off" {
			status.Warning = "compute memory enforcement is disabled by configuration"
		} else {
			limit, err := enable(settings)
			if err == nil && limit == 0 {
				err = fmt.Errorf("compute memory enforcement is unavailable on this platform")
			}
			if err != nil {
				if settings.Enforcement == "required" {
					initializeError = fmt.Errorf("%w; to continue without a compute-only hard cap, set KAVLA_MEMORY_ENFORCEMENT=off or memory.enforcement: auto", err)
					return
				}
				status.Warning = fmt.Sprintf("compute memory enforcement failed: %v", err)
			} else {
				status.Limit = limit
				budget = limit
			}
		}
		if status.Limit == 0 {
			var err error
			budget, status.InheritedLimit, err = fallbackBudget(settings.LimitPercent)
			if err != nil {
				status.Warning += fmt.Sprintf("; determine fallback budget: %v; using a conservative compute budget", err)
			}
		}
		percent := uint64(settings.DuckDBPercentOfLimit)
		status.DuckDBLimit = budget/100*percent + budget%100*percent/100
		duckDBBytes.Store(status.DuckDBLimit)
	})
	return status, initializeError
}

// DuckDBLimit leaves headroom inside the hard boundary for native allocations
// outside DuckDB's buffer manager, Arrow results, and the worker's Go runtime.
// This is only a cooperative per-engine limit, even without a hard boundary.
func DuckDBLimit() uint64 {
	return duckDBBytes.Load()
}
