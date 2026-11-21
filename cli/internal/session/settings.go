package session

import (
	"os"
	"runtime"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
	"github.com/aleda145/kavla/cli/internal/memoryguard"
)

// ComputeSettings reports resource limits on the machine that runs DuckDB.
func ComputeSettings(config *kavlaconfig.Config) map[string]interface{} {
	return map[string]interface{}{
		"memory":              config.Memory,
		"duckdbThreads":       config.DuckDBThreads,
		"availableCPUs":       runtime.NumCPU(),
		"supportsOSLimit":     runtime.GOOS == "linux",
		"availableMiB":        memoryguard.AvailableMiB(),
		"enforcementOverride": os.Getenv("KAVLA_MEMORY_ENFORCEMENT"),
	}
}
