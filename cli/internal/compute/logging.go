package compute

import (
	"context"
	"fmt"
	"strings"
)

type queryLogKey struct{}

type queryLog struct {
	name   string
	sql    string
	worker *process // Accessed under the client's operation gate.
}

// WithQueryLog keeps the submitted SQL available after it is wrapped for execution.
func WithQueryLog(ctx context.Context, name, sql string) context.Context {
	return context.WithValue(ctx, queryLogKey{}, &queryLog{name: strings.TrimSpace(name), sql: sql})
}

func (c *Client) logWorker(p *process, format string, args ...interface{}) {
	c.logf("(%d) %s", p.cmd.Process.Pid, fmt.Sprintf(format, args...))
}

func (c *Client) verboseWorker(p *process, format string, args ...interface{}) {
	if c.verbosef != nil {
		c.verbosef("(%d) %s", p.cmd.Process.Pid, fmt.Sprintf(format, args...))
	}
}

func (c *Client) logSQL(ctx context.Context, p *process, req request) {
	query, _ := ctx.Value(queryLogKey{}).(*queryLog)
	switch req.Op {
	case "create-view", "count":
		if query == nil {
			return
		}
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
	c.logf("(%d)%s:\n%s\n\n", p.cmd.Process.Pid, name, sql)
}
