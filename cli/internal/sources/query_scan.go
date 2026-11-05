package sources

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

type QueryScan struct {
	BytesProcessed *int64 `json:"bytesProcessed,string,omitempty"`
	Error          string `json:"error,omitempty"`
}

type QueryScanReader interface {
	ReadQueryScan(ctx context.Context, db *sql.DB, sourceName, query string, startedAt, finishedAt time.Time) (*QueryScan, error)
}

func (bigQueryAdapter) ReadQueryScan(ctx context.Context, db *sql.DB, sourceName, query string, startedAt, finishedAt time.Time) (*QueryScan, error) {
	// Read metadata only. The stable query comment identifies this canvas node
	// without invalidating BigQuery's cache on every run. Require one matching
	// job in the run's time window; never guess from the latest project job.
	const timestampLayout = "2006-01-02 15:04:05.000000"
	metadataSQL := fmt.Sprintf(`
		WITH jobs AS MATERIALIZED (
			SELECT * FROM bigquery_jobs(%s, allUsers = false, maxResults = 1000,
				minCreationTime = %s, maxCreationTime = %s)
		), matched AS (
			SELECT bytes_processed FROM jobs
			WHERE json_extract_string(configuration, '$.query.query') = %s
				AND state = 'Completed'
		)
		SELECT (SELECT COUNT(*) FROM jobs), COUNT(*), MAX(bytes_processed) FROM matched
	`, sqlSingleQuoted(sourceName), sqlSingleQuoted(startedAt.UTC().Format(timestampLayout)), sqlSingleQuoted(finishedAt.UTC().Format(timestampLayout)), sqlSingleQuoted(query))
	var listed, matched int64
	var bytes sql.NullInt64
	if err := db.QueryRowContext(ctx, metadataSQL).Scan(&listed, &matched, &bytes); err != nil {
		return nil, fmt.Errorf("BigQuery scan metadata: %w", err)
	}
	if listed >= 1000 || matched != 1 || !bytes.Valid || bytes.Int64 < 0 {
		return nil, fmt.Errorf("scanned bytes unavailable: no unambiguous BigQuery job statistics for this run")
	}
	return &QueryScan{BytesProcessed: &bytes.Int64}, nil
}
