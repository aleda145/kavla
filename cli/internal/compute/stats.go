package compute

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

type Stats struct {
	State             string  `json:"state"`
	PID               int     `json:"pid,omitempty"`
	UptimeSeconds     float64 `json:"uptimeSeconds,omitempty"`
	ResidentBytes     *uint64 `json:"residentBytes,omitempty"`
	PeakResidentBytes *uint64 `json:"peakResidentBytes,omitempty"`
	SwapBytes         *uint64 `json:"swapBytes,omitempty"`
	Threads           *uint64 `json:"threads,omitempty"`
	DuckDBLimitBytes  uint64  `json:"duckdbLimitBytes,omitempty"`
	SharedLimitBytes  uint64  `json:"sharedLimitBytes,omitempty"`
	Error             string  `json:"error,omitempty"`
	MetricsError      string  `json:"metricsError,omitempty"`
}

// Stats does not take the operation gate or send SQL to the worker. Monitoring
// must remain responsive during queries and must not wake suspended documents.
func (c *Client) Stats() Stats {
	c.mu.Lock()
	p, message, closed := c.worker, c.workerError, c.closed
	c.mu.Unlock()
	result := Stats{State: "standby", Error: message}
	if closed || message != "" {
		result.State = "stopped"
		return result
	}
	if p == nil {
		if len(c.gate) != 0 {
			result.State = "starting"
		}
		return result
	}
	select {
	case <-p.done:
		result.State = "stopped"
		result.Error = stoppedMessage
		return result
	default:
	}
	result.State = "idle"
	if len(c.gate) != 0 {
		result.State = "busy"
	}
	result.PID = p.cmd.Process.Pid
	result.UptimeSeconds = time.Since(p.started).Seconds()
	result.DuckDBLimitBytes = p.limits.DuckDBLimit
	result.SharedLimitBytes = p.limits.Limit
	if err := readProcessStats(&result); err != nil {
		result.MetricsError = err.Error()
	}
	return result
}

func readProcessStats(result *Stats) error {
	if runtime.GOOS == "darwin" {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		output, err := exec.CommandContext(ctx, "ps", "-o", "rss=", "-p", strconv.Itoa(result.PID)).Output()
		if err != nil {
			return fmt.Errorf("read process memory: %w", err)
		}
		value, err := strconv.ParseUint(strings.TrimSpace(string(output)), 10, 64)
		if err != nil {
			return fmt.Errorf("read process memory: %w", err)
		}
		value *= 1024
		result.ResidentBytes = &value
		return nil
	}
	if runtime.GOOS != "linux" {
		return fmt.Errorf("process memory metrics are unavailable on %s", runtime.GOOS)
	}
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", result.PID))
	if err != nil {
		return fmt.Errorf("read process metrics: %w", err)
	}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		var target **uint64
		switch fields[0] {
		case "VmRSS:":
			target = &result.ResidentBytes
		case "VmHWM:":
			target = &result.PeakResidentBytes
		case "VmSwap:":
			target = &result.SwapBytes
		case "Threads:":
			target = &result.Threads
		default:
			continue
		}
		value, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			return fmt.Errorf("parse process metric %s: %w", fields[0], err)
		}
		if fields[0] != "Threads:" {
			value *= 1024
		}
		*target = &value
	}
	if result.ResidentBytes == nil {
		return fmt.Errorf("process memory is unavailable; the worker may have exited")
	}
	return nil
}
