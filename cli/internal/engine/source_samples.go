package engine

import (
	"context"
	"fmt"
	"math"
	"strings"
)

// ExportSourceSample scans the source once and writes only the sampled rows.
// The document retains this Parquet file, so subsequent queries never resample.
func (e *Engine) ExportSourceSample(ctx context.Context, tableRef string, percent float64, outputPath string) error {
	if math.IsNaN(percent) || math.IsInf(percent, 0) || percent <= 0 || percent >= 100 {
		return fmt.Errorf("sample percentage must be greater than 0 and less than 100")
	}
	parts := strings.Split(tableRef, ".")
	if len(parts) < 2 {
		return fmt.Errorf("sample source must include a catalog and table")
	}
	for _, part := range parts {
		if strings.TrimSpace(part) == "" {
			return fmt.Errorf("invalid sample source table")
		}
	}
	sourceName := parts[0]
	if err := e.ensureConfiguredSourceHealthy(ctx, sourceName); err != nil {
		return err
	}
	quoted := make([]string, len(parts))
	for i, part := range parts {
		quoted[i] = quoteIdentifier(part)
	}
	query := fmt.Sprintf("SELECT * FROM %s USING SAMPLE %g PERCENT (bernoulli)", strings.Join(quoted, "."), percent)
	sourceType := e.sourceConfigs[sourceName].Type
	if sourceType == "postgres" || sourceType == "bigquery" {
		return fmt.Errorf("%s sampling runs natively; saved samples are not created", sourceType)
	}
	if err := e.ensureDeferredTables(ctx, query); err != nil {
		return err
	}
	_, err := e.db.ExecContext(ctx, fmt.Sprintf("COPY (%s) TO %s (FORMAT PARQUET, COMPRESSION ZSTD)", query, sqlStringLiteral(outputPath)))
	if err != nil {
		return fmt.Errorf("create source sample: %w", err)
	}
	return nil
}
