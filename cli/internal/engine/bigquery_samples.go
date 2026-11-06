package engine

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/aleda145/kavla/cli/internal/sources"
	"github.com/google/uuid"
)

type SourceSample struct {
	TableRef string                 `json:"tableRef"`
	Estimate *sources.QueryEstimate `json:"estimate,omitempty"`
}

// BigQuery samples stay in the warehouse. IF NOT EXISTS preserves the sample
// until BigQuery expires it, including across document and worker restarts.
func (e *Engine) PrepareBigQuerySample(ctx context.Context, tableRef string, percent float64, dryRun bool) (result *SourceSample, resultErr error) {
	started := time.Now()
	logf := func(format string, args ...interface{}) {
		e.logf("BigQuery sample [%s %g%%]: %s", tableRef, percent, fmt.Sprintf(format, args...))
	}
	logf("started (dry_run=%t)", dryRun)
	defer func() {
		if resultErr != nil {
			logf("failed after %s: %v", time.Since(started).Round(time.Millisecond), resultErr)
		} else {
			logf("finished after %s", time.Since(started).Round(time.Millisecond))
		}
	}()
	if math.IsNaN(percent) || math.IsInf(percent, 0) || percent <= 0 || percent >= 100 {
		return nil, fmt.Errorf("sample percentage must be greater than 0 and less than 100")
	}
	parts := strings.Split(tableRef, ".")
	if len(parts) != 3 && len(parts) != 4 {
		return nil, fmt.Errorf("BigQuery sample source must include a catalog, dataset and table")
	}
	for _, part := range parts {
		if strings.TrimSpace(part) == "" {
			return nil, fmt.Errorf("invalid BigQuery sample source table")
		}
	}
	sourceName := parts[0]
	config := e.sourceConfigs[sourceName]
	if config.Type != "bigquery" {
		return nil, fmt.Errorf("source %q is not BigQuery", sourceName)
	}
	connection := strings.TrimSpace(config.Connection)
	if !strings.Contains(connection, "project=") {
		connection = "project=" + connection
	}
	project := ""
	for _, option := range strings.Fields(connection) {
		if value, ok := strings.CutPrefix(option, "project="); ok {
			project = value
		}
	}
	if project == "" {
		return nil, fmt.Errorf("BigQuery source is missing its project")
	}
	if err := e.ensureConfiguredSourceHealthy(ctx, sourceName); err != nil {
		return nil, err
	}
	quote := func(value string) string {
		return "`" + strings.ReplaceAll(strings.ReplaceAll(value, "\\", "\\\\"), "`", "\\`") + "`"
	}
	nativeTable := strings.Join(parts[1:], ".")
	if len(parts) == 3 {
		nativeTable = project + "." + nativeTable
	}
	// A small table can occupy one storage block, so TABLESAMPLE can return
	// every row. Use row sampling for small sources; large base tables retain
	// block sampling to avoid reading the whole table during creation.
	fullSQL := fmt.Sprintf("SELECT * FROM %s", quote(nativeTable))
	logf("full-source dry-run SQL: %s", fullSQL)
	fullEstimate, err := e.EstimateQuery(ctx, "bigquery", sourceName, fullSQL)
	if err != nil {
		return nil, err
	}
	logf("full-source estimate: %d bytes", fullEstimate.BytesProcessed)
	selectSQL := fmt.Sprintf("%s TABLESAMPLE SYSTEM (%g PERCENT)", fullSQL, percent)
	method := "block sampling (row percentage can vary with block sizes)"
	if fullEstimate.BytesProcessed > 0 && fullEstimate.BytesProcessed <= 1<<30 {
		selectSQL = fmt.Sprintf("%s WHERE RAND() < %g", fullSQL, percent/100)
		method = "row sampling (source estimate <= 1 GiB; creation scans the source)"
	}
	logf("sample dry-run SQL: %s", selectSQL)
	estimate, err := e.EstimateQuery(ctx, "bigquery", sourceName, selectSQL)
	if err != nil && strings.Contains(err.Error(), "TABLESAMPLE SYSTEM can only be applied directly to base tables") {
		logf("block sampling unsupported: %v", err)
		selectSQL = fmt.Sprintf("%s WHERE RAND() < %g", fullSQL, percent/100)
		method = "row sampling (view/non-base source; creation scans the source)"
		logf("sample dry-run SQL: %s", selectSQL)
		estimate, err = e.EstimateQuery(ctx, "bigquery", sourceName, selectSQL)
	}
	if err != nil {
		return nil, err
	}
	logf("method: %s; sample estimate: %d bytes; full-source estimate: %d bytes", method, estimate.BytesProcessed, fullEstimate.BytesProcessed)
	// Version the cache by the actual sampling SQL so an old block sample
	// containing the whole small table cannot be reused as a row sample.
	key := sha256.Sum256([]byte("sample-v2\x00" + selectSQL))
	name := fmt.Sprintf("sample_%x_%s_perc", key[:12], strings.ReplaceAll(fmt.Sprintf("%g", percent), ".", "_"))
	result = &SourceSample{TableRef: sourceName + ".kavla_cache." + name}
	logf("cache table: %s.kavla_cache.%s (24-hour expiry; reuse does not extend it)", project, name)
	if dryRun {
		// Estimate the exact SELECT used by CTAS, without creating a table or
		// depending on whether the destination already exists.
		result.Estimate = estimate
		return result, nil
	}

	// The normal catalog remains READ_ONLY. Only this operation gets a private
	// writable attachment, using the same connection and credentials.
	writer := "_kavla_sample_writer_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	attachSQL := fmt.Sprintf("ATTACH %s AS %s (TYPE bigquery)", sqlStringLiteral(connection), quoteIdentifier(writer))
	if _, err := e.db.ExecContext(ctx, attachSQL); err != nil {
		return nil, fmt.Errorf("open BigQuery sample writer: %w", err)
	}
	defer func() {
		_, err := e.db.ExecContext(context.WithoutCancel(ctx), "DETACH "+quoteIdentifier(writer))
		resultErr = errors.Join(resultErr, err)
	}()
	// BigQuery infers the job location from the referenced source dataset. A
	// zero-row query gives us that location without reading the table's data;
	// a dry run does not reliably include a job reference/location.
	locationSQL := fmt.Sprintf("SELECT 1 FROM %s LIMIT 0", quote(nativeTable))
	logf("location probe SQL: %s", locationSQL)
	var location string
	if err := e.db.QueryRowContext(ctx, fmt.Sprintf("SELECT location FROM bigquery_execute(%s, %s)", sqlStringLiteral(writer), sqlStringLiteral(locationSQL))).Scan(&location); err != nil {
		return nil, fmt.Errorf("determine BigQuery sample dataset location: %w", err)
	}
	location = strings.TrimSpace(location)
	if location == "" {
		return nil, fmt.Errorf("BigQuery did not return the source dataset's location")
	}
	schemaSQL := fmt.Sprintf("CREATE SCHEMA IF NOT EXISTS %s OPTIONS (location = %s)", quote(project+".kavla_cache"), sqlStringLiteral(location))
	logf("location: %s; dataset SQL: %s", location, schemaSQL)
	var schemaCreated bool
	if err := e.db.QueryRowContext(ctx, fmt.Sprintf("SELECT success FROM bigquery_execute(%s, %s)", sqlStringLiteral(writer), sqlStringLiteral(schemaSQL))).Scan(&schemaCreated); err != nil {
		return nil, fmt.Errorf("prepare BigQuery cache dataset %s.kavla_cache in %s (requires permission to create datasets when missing): %w", project, location, err)
	}
	if !schemaCreated {
		return nil, fmt.Errorf("BigQuery did not confirm cache dataset creation")
	}
	createSQL := fmt.Sprintf("CREATE TABLE IF NOT EXISTS %s OPTIONS (expiration_timestamp = TIMESTAMP_ADD(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)) AS %s", quote(project+".kavla_cache."+name), selectSQL)
	logf("creation SQL: %s", createSQL)
	var success bool
	var jobID, jobLocation string
	var bytes sql.NullInt64
	err = e.db.QueryRowContext(ctx, fmt.Sprintf("SELECT success, job_id, location, total_bytes_processed FROM bigquery_execute(%s, %s)", sqlStringLiteral(writer), sqlStringLiteral(createSQL))).Scan(&success, &jobID, &jobLocation, &bytes)
	if err != nil {
		return nil, fmt.Errorf("create BigQuery sample (requires %s.kavla_cache in %s and permission to create tables): %w", project, location, err)
	}
	if !success {
		return nil, fmt.Errorf("BigQuery did not confirm sample creation")
	}
	logf("creation job: %s; location: %s; bytes processed: %v (available=%t)", jobID, jobLocation, bytes.Int64, bytes.Valid)
	// The job's DDL operation distinguishes CREATE from SKIP. Zero processed
	// bytes alone is not proof of cache reuse (an empty source also reads zero).
	var ddlOperation sql.NullString
	jobSQL := fmt.Sprintf("SELECT json_extract_string(statistics, '$.query.ddlOperationPerformed') FROM bigquery_jobs(%s, jobId = %s)", sqlStringLiteral(writer), sqlStringLiteral(jobID))
	if err := e.db.QueryRowContext(ctx, jobSQL).Scan(&ddlOperation); err != nil {
		logf("sample is ready, but cache reuse metadata is unavailable for job %s: %v", jobID, err)
	} else {
		logf("cache operation: %s (CREATE = new sample, SKIP = existing sample reused)", ddlOperation.String)
	}
	return result, nil
}
