// Package compute runs each document's DuckDB engine in a supervised process.
// Only the worker enters the memory cgroup; the canvas server owns documents.
package compute

import (
	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
	"github.com/aleda145/kavla/cli/internal/engine"
)

const workerArgument = "_kavla_compute_worker"
const completeTrailer = "Kavla-Compute-Complete"
const sourceStatusesHeader = "Kavla-Source-Statuses"
const sourceStatusPrefix = "KAVLA_SOURCE_STATUS "

type configuration struct {
	Sources     map[string]kavlaconfig.SourceConfig
	Directories []string
	Token       string
	Memory      kavlaconfig.MemorySettings
}

type ready struct {
	Address      string
	Statuses     []engine.SourceStatus
	Limit        uint64
	DuckDBLimit  uint64
	SwapLimitMiB int64
	Error        string
}

type request struct {
	Op              string
	SQL             string
	ID              string
	Source          string
	ExecutionEngine string
	FileName        string
	Path            string
	Format          string
	Offset          int
	Limit           int
	Columns         []engine.WidgetColumn
	Rows            [][]interface{}
}

type response struct {
	Error   string
	SQL     string
	Tables  []string
	Columns []map[string]string
	Stats   map[string]int64
	Count   int64
	Schema  []engine.ResultColumn
}
