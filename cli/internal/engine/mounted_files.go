package engine

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
)

func (e *Engine) PrepareRemoteFileMountSQL(sourceName, fileName, blobURL string) (string, error) {
	return buildRemoteFileMountSQL(sourceName, fileName, blobURL)
}

func (e *Engine) MountRemoteFileSource(ctx context.Context, sourceName, fileName, blobURL string) error {
	sql, err := e.PrepareRemoteFileMountSQL(sourceName, fileName, blobURL)
	if err != nil {
		return err
	}

	if _, err := e.db.ExecContext(ctx, sql); err != nil {
		return fmt.Errorf("failed to mount remote file source %q: %w", sourceName, err)
	}

	return nil
}

func buildRemoteFileMountSQL(sourceName, fileName, blobURL string) (string, error) {
	sourceName = strings.TrimSpace(sourceName)
	fileName = strings.TrimSpace(fileName)
	blobURL = strings.TrimSpace(blobURL)

	if sourceName == "" {
		return "", fmt.Errorf("mounted file source requires sourceName")
	}
	if fileName == "" {
		return "", fmt.Errorf("mounted file source %q requires fileName", sourceName)
	}
	if blobURL == "" {
		return "", fmt.Errorf("mounted file source %q requires a blob URL", sourceName)
	}

	reader, err := readerForMountedFile(fileName)
	if err != nil {
		return "", err
	}

	return fmt.Sprintf(
		"CREATE OR REPLACE VIEW %s AS SELECT * FROM %s(%s)",
		quoteIdentifier(sourceName),
		reader,
		sqlStringLiteral(blobURL),
	), nil
}

func readerForMountedFile(fileName string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(fileName))
	switch {
	case strings.HasSuffix(normalized, ".parquet"):
		return "read_parquet", nil
	case strings.HasSuffix(normalized, ".csv"):
		return "read_csv_auto", nil
	case strings.HasSuffix(normalized, ".json"), strings.HasSuffix(normalized, ".ndjson"):
		return "read_json_auto", nil
	default:
		ext := strings.ToLower(filepath.Ext(normalized))
		if ext == "" {
			return "", fmt.Errorf("unsupported mounted file type for %q", fileName)
		}
		return "", fmt.Errorf("unsupported mounted file type %q for %q", ext, fileName)
	}
}

func quoteIdentifier(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}

func sqlStringLiteral(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}
