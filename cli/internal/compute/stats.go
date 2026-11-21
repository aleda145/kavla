package compute

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

type Stats struct {
	State           string   `json:"state"`
	PID             int      `json:"pid,omitempty"`
	Uptime          *int64   `json:"uptime,omitempty"`
	MemoryAllocated *uint64  `json:"memory_allocated,omitempty"`
	MemoryLimit     uint64   `json:"memory_limit,omitempty"`
	ThreadsLimit    int      `json:"threads_limit,omitempty"`
	CPUUsage        *float64 `json:"cpu_usage,omitempty"`
	Error           string   `json:"error,omitempty"`
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
	uptime := int64(time.Since(p.started).Round(time.Second) / time.Second)
	result.Uptime = &uptime
	result.ThreadsLimit = p.limits.DuckDBThreads
	result.MemoryLimit = p.limits.DuckDBMemoryLimitBytes
	return result
}

// Each append is one complete JSON line. A document keeps the same file across
// worker restarts and canvas renames.
func (c *Client) startStatsHistory(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(file)
	var previousPID int
	var previousTime time.Time
	var previousCPU time.Duration
	record := func() error {
		stats := c.Stats()
		now := time.Now()
		if stats.PID != 0 {
			resident, cpu, err := readWorkerUsage(stats.PID)
			now = time.Now()
			if err != nil {
				stats.Error = err.Error()
				previousPID = 0
			} else {
				stats.MemoryAllocated = &resident
				if stats.PID == previousPID && cpu >= previousCPU && now.After(previousTime) {
					percent := 100 * float64(cpu-previousCPU) / float64(now.Sub(previousTime))
					stats.CPUUsage = &percent
				}
				previousPID, previousTime, previousCPU = stats.PID, now, cpu
			}
		} else {
			previousPID = 0
		}
		return encoder.Encode(struct {
			Timestamp time.Time `json:"timestamp"`
			Stats
		}{now.UTC(), stats})
	}
	if err := record(); err != nil {
		_ = file.Close()
		return err
	}
	c.historyDone = make(chan struct{})
	go func() {
		defer close(c.historyDone)
		defer func() {
			if err := file.Close(); err != nil {
				c.logf("Close DuckDB stats history: %v", err)
			}
		}()
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		failed := false
		for {
			select {
			case <-c.ctx.Done():
				return
			case <-ticker.C:
				err := record()
				if err != nil && !failed {
					c.logf("Append DuckDB stats history: %v", err)
				}
				failed = err != nil
			}
		}
	}()
	return nil
}
