package compute

import (
	"context"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/aleda145/kavla/cli/internal/engine"
)

type queryLogKey struct{}

type queryLog struct {
	name   string
	sql    string
	worker *process // Accessed under the client's operation gate.
}

// WithQueryLog keeps the submitted SQL available after it is wrapped for execution.
func WithQueryLog(ctx context.Context, name, sql string) context.Context {
	if _, ok := ctx.Value(queryLogKey{}).(*queryLog); ok {
		return ctx
	}
	return context.WithValue(ctx, queryLogKey{}, &queryLog{name: strings.TrimSpace(name), sql: sql})
}

func QueryLogPrefix(ctx context.Context) string {
	query, _ := ctx.Value(queryLogKey{}).(*queryLog)
	if query == nil {
		return ""
	}
	return query.prefix(query.worker)
}

func (query *queryLog) prefix(worker *process) string {
	prefix := ""
	if worker != nil {
		prefix = fmt.Sprintf("(%d) ", worker.cmd.Process.Pid)
	}
	if query != nil && query.name != "" {
		prefix += "(" + query.name + ") "
	}
	return prefix
}

func (c *Client) verboseWait(ctx context.Context, worker *process, label string) func(error) {
	if c.verbosef == nil {
		return func(error) {}
	}
	query, _ := ctx.Value(queryLogKey{}).(*queryLog)
	prefix := query.prefix(worker)
	started := time.Now()
	reported := make(chan struct{})
	timer := time.AfterFunc(5*time.Second, func() {
		c.verbosef("%sWaiting for %s (5s)", prefix, label)
		close(reported)
	})
	return func(err error) {
		if timer.Stop() {
			return
		}
		<-reported
		elapsed := time.Since(started).Round(time.Millisecond)
		if err != nil {
			c.verbosef("%sWait for %s ended after %s: %v", prefix, label, elapsed, err)
			return
		}
		c.verbosef("%sWait for %s ended after %s", prefix, label, elapsed)
	}
}

func (c *Client) logWorker(p *process, format string, args ...interface{}) {
	c.logf("(%d) %s", p.cmd.Process.Pid, fmt.Sprintf(format, args...))
}

func (c *Client) verboseWorker(p *process, format string, args ...interface{}) {
	if c.verbosef != nil {
		c.verbosef("(%d) %s", p.cmd.Process.Pid, fmt.Sprintf(format, args...))
	}
}

func (c *Client) logSourceStatus(p *process, status engine.SourceStatus) {
	switch {
	case status.Loading:
		c.logWorker(p, "Connecting to source %q (%s)", status.Name, status.Type)
	case status.Available:
		c.logWorker(p, "Connected to source %q (%s) in %s", status.Name, status.Type, status.ConnectionTime.Round(time.Millisecond))
	case status.Error != "" && status.ConnectionTime > 0:
		c.logWorker(p, "Source %q (%s) unavailable after %s: %s", status.Name, status.Type, status.ConnectionTime.Round(time.Millisecond), status.Error)
	case status.Error != "":
		c.logWorker(p, "Source %q (%s) unavailable: %s", status.Name, status.Type, status.Error)
	}
}

func (c *Client) logWorkerStarted(p *process, info ready, elapsed time.Duration) {
	var details []string
	if info.DuckDBMemoryLimit != "" {
		memory := "buffer limit " + info.DuckDBMemoryLimit
		if info.Memory.DuckDBLimit == 0 {
			memory += " (automatic)"
		}
		details = append(details, memory, fmt.Sprintf("%d DuckDB threads", info.DuckDBThreads))
	}
	if info.Memory.Limit > 0 {
		details = append(details, fmt.Sprintf("Kavla RAM cap %.2f GiB", float64(info.Memory.Limit)/(1<<30)))
	} else if info.Memory.Configured {
		details = append(details, "no verified Kavla compute cap")
	} else {
		details = append(details, "no Kavla compute cap")
	}
	if limit := info.SystemLimits.CgroupRAMBytes; limit != nil && *limit != math.MaxUint64 && *limit != info.Memory.Limit {
		details = append(details, fmt.Sprintf("cgroup RAM cap %.2f GiB", float64(*limit)/(1<<30)))
	}
	if total := info.SystemLimits.TotalSwapBytes; total != nil {
		details = append(details, fmt.Sprintf("system swap %.1f GiB", float64(*total)/(1<<30)))
	}
	swapLimit := info.SystemLimits.CgroupSwapBytes
	switch {
	case swapLimit == nil:
		details = append(details, "swap cap unknown")
	case *swapLimit == math.MaxUint64:
		details = append(details, "no visible cgroup swap cap")
	case *swapLimit == 0:
		details = append(details, "cgroup swap disabled")
	default:
		details = append(details, fmt.Sprintf("cgroup swap cap %g MiB", float64(*swapLimit)/(1<<20)))
	}
	c.logWorker(p, "DuckDB worker started in %s (%s)", elapsed.Round(time.Millisecond), strings.Join(details, ", "))
	if info.Memory.Warning != "" {
		c.logWorker(p, "Warning: %s", info.Memory.Warning)
	}
}

func (c *Client) logSQL(ctx context.Context, p *process, req request) {
	query, _ := ctx.Value(queryLogKey{}).(*queryLog)
	switch req.Op {
	case "create-view", "count":
		if query == nil || query.sql == "" {
			return
		}
	case "page":
		if query != nil {
			query.worker = p
		}
		return
	case "query", "widget":
	default:
		return
	}
	sql := strings.TrimSpace(req.SQL)
	name := ""
	if query != nil {
		// A local run creates a view and then counts it. Log again only if
		// recovery sends the same run to a different worker.
		if query.worker == p {
			return
		}
		query.worker = p
		sql = strings.TrimSpace(query.sql)
		if query.name != "" {
			name = " (" + query.name + ")"
		}
	}
	c.logf("(%d)%s:\n%s", p.cmd.Process.Pid, name, sql)
}
