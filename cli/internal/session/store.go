package session

import (
	"context"
	"fmt"
	"strings"

	"github.com/aleda145/kavla/cli/internal/engine"
	"github.com/aleda145/kavla/cli/internal/runner"
)

func (s *Session) StoreDestination(sourceName, schemaName, tableName string) (*engine.StoredTable, error) {
	return s.engine.StoreDestination(sourceName, schemaName, tableName)
}

func (s *Session) SnapshotQuery(ctx context.Context, req runner.QueryRequest, path string, result *engine.StoredTable) error {
	if strings.TrimSpace(req.SQL) == "" {
		return fmt.Errorf("SQL is required")
	}
	if len(req.MountedFileSources) != 0 {
		return fmt.Errorf("Store requires document upload tables for file sources")
	}
	query, err := runner.PreparePreviewSQL(req, s.engine, 0)
	if err != nil {
		return err
	}
	return s.engine.SnapshotQuery(ctx, query, path, result)
}

func (s *Session) StoreSnapshot(ctx context.Context, path string, result *engine.StoredTable) error {
	return s.engine.StoreSnapshot(ctx, path, result)
}
