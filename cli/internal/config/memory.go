package config

import (
	"fmt"
	"math"

	"gopkg.in/yaml.v3"
)

// Pointers distinguish omitted percentages from an invalid explicit zero.
type MemoryConfig struct {
	LimitPercent         *int  `yaml:"limit_percent,omitempty"`
	DuckDBPercentOfLimit *int  `yaml:"duckdb_percent_of_limit,omitempty"`
	SwapLimitMiB         int64 `yaml:"swap_limit_mib,omitempty"`
}

// MemorySettings contains validated defaults, also sent to compute workers.
type MemorySettings struct {
	LimitPercent         int
	DuckDBPercentOfLimit int
	SwapLimitMiB         int64
}

func (m MemoryConfig) Resolve() (MemorySettings, error) {
	settings := MemorySettings{LimitPercent: 50, DuckDBPercentOfLimit: 50, SwapLimitMiB: m.SwapLimitMiB}
	if m.LimitPercent != nil {
		settings.LimitPercent = *m.LimitPercent
	}
	if m.DuckDBPercentOfLimit != nil {
		settings.DuckDBPercentOfLimit = *m.DuckDBPercentOfLimit
	}
	return settings, settings.Validate()
}

func (m MemorySettings) Validate() error {
	if m.LimitPercent < 1 || m.LimitPercent > 100 {
		return fmt.Errorf("memory.limit_percent must be an integer between 1 and 100")
	}
	if m.DuckDBPercentOfLimit < 1 || m.DuckDBPercentOfLimit > 99 {
		return fmt.Errorf("memory.duckdb_percent_of_limit must be an integer between 1 and 99, leaving headroom for allocations outside DuckDB's buffer manager")
	}
	if m.SwapLimitMiB < 0 || m.SwapLimitMiB > math.MaxInt64/(1<<20) {
		return fmt.Errorf("memory.swap_limit_mib must be a non-negative integer no greater than %d", int64(math.MaxInt64/(1<<20)))
	}
	return nil
}

func (m MemorySettings) SwapBytes() uint64 {
	return uint64(m.SwapLimitMiB) * (1 << 20)
}

// Reject misspelled memory keys rather than silently using a different limit.
// Keep the existing decoding rules for older, unrelated configuration fields.
func (m *MemoryConfig) UnmarshalYAML(node *yaml.Node) error {
	if node.Kind != yaml.MappingNode {
		return fmt.Errorf("memory must contain limit_percent, duckdb_percent_of_limit, or swap_limit_mib settings")
	}
	for i := 0; i < len(node.Content); i += 2 {
		switch node.Content[i].Value {
		case "limit_percent", "duckdb_percent_of_limit", "swap_limit_mib":
			value := node.Content[i+1]
			if value.Tag != "!!int" {
				return fmt.Errorf("memory.%s must be an integer", node.Content[i].Value)
			}
		default:
			return fmt.Errorf("unknown memory setting %q", node.Content[i].Value)
		}
	}
	type plain MemoryConfig
	return node.Decode((*plain)(m))
}
