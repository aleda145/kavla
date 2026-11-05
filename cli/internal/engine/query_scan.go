package engine

import (
	"context"
	"time"

	"github.com/aleda145/kavla/cli/internal/sources"
)

func (e *Engine) ReadQueryScan(ctx context.Context, sourceName, query string, startedAt, finishedAt time.Time) (*sources.QueryScan, error) {
	reader, ok := e.adapters[sourceName].(sources.QueryScanReader)
	if !ok {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return reader.ReadQueryScan(ctx, e.db, sourceName, query, startedAt, finishedAt)
}
