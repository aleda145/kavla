package sources

import (
	"context"
	"database/sql"
	"fmt"
)

// QueryEstimator is optional: adapters without a dry-run API need not implement it.
type QueryEstimator interface {
	EstimateQuery(ctx context.Context, db *sql.DB, sourceName, query string) (*QueryEstimate, error)
}

type QueryEstimate struct {
	Engine         string `json:"engine"`
	BytesProcessed int64  `json:"bytesProcessed,string"`
}

func (bigQueryAdapter) EstimateQuery(ctx context.Context, db *sql.DB, sourceName, query string) (*QueryEstimate, error) {
	// Keep the query inside a string literal and always enable dry_run. Never
	// fall back to executing the query when the extension cannot estimate it.
	estimateSQL := fmt.Sprintf("SELECT total_bytes_processed FROM bigquery_query(%s, %s, dry_run = true)", sqlSingleQuoted(sourceName), sqlSingleQuoted(query))
	var bytes sql.NullInt64
	if err := db.QueryRowContext(ctx, estimateSQL).Scan(&bytes); err != nil {
		return nil, fmt.Errorf("BigQuery dry run: %w", err)
	}
	if !bytes.Valid || bytes.Int64 < 0 {
		return nil, fmt.Errorf("BigQuery did not return a processed-byte estimate")
	}
	return &QueryEstimate{Engine: "bigquery", BytesProcessed: bytes.Int64}, nil
}
