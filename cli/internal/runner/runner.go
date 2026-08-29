package runner

import (
	"bytes"
	"context"
	"fmt"
	"math"
	"strings"

	"github.com/aleda145/kavla/cli/internal/engine"
	"github.com/apache/arrow/go/v14/arrow"
	"github.com/apache/arrow/go/v14/arrow/ipc"
	"github.com/apache/arrow/go/v14/arrow/memory"
	"github.com/apache/arrow/go/v14/parquet"
	"github.com/apache/arrow/go/v14/parquet/compress"
	"github.com/apache/arrow/go/v14/parquet/pqarrow"
)

type ResultFormat string

const (
	ResultFormatArrow   ResultFormat = "arrow"
	ResultFormatParquet ResultFormat = "parquet"
)

type Transport interface {
	SendResultData(shapeId string, format ResultFormat, data []byte, rowCount int64, transient bool) error
	SendJSON(msg map[string]interface{}) error
	Log(format string, args ...interface{})
	Verbose(format string, args ...interface{})
}

type resultSizeLimiter interface {
	MaxResultDataBytes() int
}

type QueryRequest struct {
	SQL string `json:"sql"`
	// ExecutionEngine enables explicit source-native preview mode for a single source.
	// Leave it empty to use the default federated DuckDB preview path.
	ExecutionEngine    string              `json:"executionEngine,omitempty"`
	SourceName         string              `json:"sourceName,omitempty"`
	MountedFileSources []MountedFileSource `json:"mountedFileSources,omitempty"`
	ShapeId            string              `json:"shapeId"`
	QueryName          string              `json:"queryName,omitempty"`
	ResultFormat       ResultFormat        `json:"resultFormat,omitempty"`
	Transient          bool                `json:"transient,omitempty"`
	Restore            bool                `json:"restore,omitempty"`
	PreviewRowLimit    int                 `json:"-"`
}

type MountedFileSource struct {
	SourceName  string `json:"sourceName"`
	BlobID      string `json:"blobId,omitempty"`
	R2ObjectKey string `json:"r2ObjectKey,omitempty"`
	FileName    string `json:"fileName"`
}

type ExecuteResult struct {
	RowCount int64
	DataSize int64
}

// maxArrowPreviewSize is the point where Parquet compression becomes preferable
// to sending an Arrow preview through the local result transport.

const maxArrowPreviewSize = 10000 * 1024 // 10 MB

const DefaultHostedPreviewRowLimit = 10000

func formatBytes(b int) string {
	if b == 0 {
		return "0 B"
	}
	units := []string{"B", "KB", "MB", "GB"}
	i := int(math.Floor(math.Log(float64(b)) / math.Log(1024)))
	if i >= len(units) {
		i = len(units) - 1
	}
	val := float64(b) / math.Pow(1024, float64(i))
	return fmt.Sprintf("%.1f %s", val, units[i])
}

func Execute(ctx context.Context, req QueryRequest, t Transport, eng *engine.Engine) (*ExecuteResult, error) {
	// 1. Query once at the default row limit
	if req.PreviewRowLimit > 0 {
		t.Log("Querying with LIMIT %d...\n", req.PreviewRowLimit)
	} else {
		t.Log("Querying without an implicit row limit...\n")
	}
	wrappedSQL, err := PreparePreviewSQL(req, eng, req.PreviewRowLimit)
	if err != nil {
		return nil, err
	}
	t.Verbose("Prepared preview SQL for source '%s':\n%s\n", req.SourceName, wrappedSQL)

	reader, err := eng.Query(ctx, wrappedSQL)
	if err != nil {
		return nil, err
	}
	defer reader.Release()
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	schema := reader.Schema()

	// Inject ShapeId into Schema Metadata
	meta := schema.Metadata()
	keys := meta.Keys()
	values := meta.Values()
	keys = append(keys, "shapeId")
	values = append(values, req.ShapeId)
	newMeta := arrow.NewMetadata(keys, values)
	schema = arrow.NewSchema(schema.Fields(), &newMeta)

	// 2. Collect all Arrow record batches in memory
	var records []arrow.Record
	var totalRows int64
	for reader.Next() {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		rec := reader.Record()
		rec.Retain() // prevent release when reader advances
		records = append(records, rec)
		totalRows += rec.NumRows()
	}
	defer func() {
		for _, rec := range records {
			rec.Release()
		}
	}()

	t.Log("Got %d rows in %d Arrow batch(es), %d columns\n", totalRows, len(records), schema.NumFields())
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	if req.ResultFormat != ResultFormatParquet {
		// 3. Try Arrow IPC first to avoid an unnecessary Parquet encode for small previews.
		t.Log("Serializing to Arrow IPC...\n")
		buf, err := serializeArrowIPC(schema, records)
		if err != nil {
			return nil, err
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}

		t.Log("Arrow IPC size: %s (limit: %s)\n", formatBytes(buf.Len()), formatBytes(maxArrowPreviewSize))

		// 4. If Arrow fits, send it directly.
		if req.ResultFormat == ResultFormatArrow || buf.Len() <= maxArrowPreviewSize {
			if limit := maxTransportResultSize(t); limit > 0 && buf.Len() > limit {
				return nil, fmt.Errorf("Arrow result is %s, exceeding the hosted transport limit of %s; reduce the query result or allow Parquet output", formatBytes(buf.Len()), formatBytes(limit))
			}
			if req.ResultFormat == ResultFormatArrow {
				t.Log("Arrow IPC requested, staging result for local download\n")
			} else {
				t.Log("Arrow IPC fits in WebSocket, sending directly\n")
			}
			result := &ExecuteResult{
				RowCount: totalRows,
				DataSize: int64(buf.Len()),
			}
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			err = t.SendResultData(req.ShapeId, ResultFormatArrow, buf.Bytes(), totalRows, req.Transient)
			return result, err
		}

		t.Log("Arrow IPC too large, serializing to Parquet (Snappy)...\n")
	} else {
		t.Log("Serializing local result to Parquet (Snappy)...\n")
	}

	// 5. Encode Parquet when requested by the local app or when Arrow is too large.
	buf, err := serializeParquet(schema, records)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	t.Log("Parquet size: %s\n", formatBytes(buf.Len()))
	rowsToSend := totalRows
	if limit := maxTransportResultSize(t); limit > 0 && buf.Len() > limit {
		var truncateErr error
		buf, rowsToSend, truncateErr = truncateParquetToLimit(schema, records, totalRows, buf.Len(), limit)
		if truncateErr != nil {
			return nil, truncateErr
		}
		t.Log("Hosted result truncated to %d rows (%s transport limit)\n", rowsToSend, formatBytes(limit))
	}
	t.Log("Sending Parquet result\n")
	result := &ExecuteResult{
		RowCount: rowsToSend,
		DataSize: int64(buf.Len()),
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	err = t.SendResultData(req.ShapeId, ResultFormatParquet, buf.Bytes(), rowsToSend, req.Transient)
	return result, err
}

func maxTransportResultSize(transport Transport) int {
	limiter, ok := transport.(resultSizeLimiter)
	if !ok {
		return 0
	}
	return limiter.MaxResultDataBytes()
}

func truncateParquetToLimit(schema *arrow.Schema, records []arrow.Record, totalRows int64, fullSize, limit int) (*bytes.Buffer, int64, error) {
	if totalRows <= 0 {
		return nil, 0, fmt.Errorf("empty Parquet result unexpectedly exceeded the hosted transport limit")
	}

	targetRows := int64(float64(totalRows) * (float64(limit) / float64(fullSize)) * 0.85)
	if targetRows < 1 {
		targetRows = 1
	}
	for {
		buffer, written, err := serializeTruncated(schema, records, targetRows)
		if err != nil {
			return nil, 0, err
		}
		if buffer.Len() <= limit {
			return buffer, written, nil
		}
		if targetRows == 1 {
			return nil, 0, fmt.Errorf("one result row is too large for the hosted transport limit of %s", formatBytes(limit))
		}
		targetRows /= 2
		if targetRows < 1 {
			targetRows = 1
		}
	}
}

func PreparePreviewSQL(req QueryRequest, eng *engine.Engine, limit int) (string, error) {
	cleanSQL := strings.TrimSuffix(strings.TrimSpace(req.SQL), ";")
	executionEngine := strings.TrimSpace(req.ExecutionEngine)
	sourceName := strings.TrimSpace(req.SourceName)

	if executionEngine == "" {
		return eng.PreparePreviewSQL("", "", cleanSQL, limit)
	}

	if sourceName == "" {
		return "", fmt.Errorf("source-native preview mode requires sourceName")
	}

	return eng.PreparePreviewSQL(executionEngine, sourceName, cleanSQL, limit)
}

func serializeArrowIPC(schema *arrow.Schema, records []arrow.Record) (*bytes.Buffer, error) {
	buf := new(bytes.Buffer)
	writer := ipc.NewWriter(buf, ipc.WithSchema(schema))

	for _, rec := range records {
		if err := writer.Write(rec); err != nil {
			_ = writer.Close()
			return nil, err
		}
	}

	if err := writer.Close(); err != nil {
		return nil, err
	}

	return buf, nil
}

// serializeParquet writes all records to a Parquet buffer.
func serializeParquet(schema *arrow.Schema, records []arrow.Record) (*bytes.Buffer, error) {
	mem := memory.NewGoAllocator()
	buf := new(bytes.Buffer)

	props := parquet.NewWriterProperties(parquet.WithCompression(compress.Codecs.Snappy))
	arrowProps := pqarrow.NewArrowWriterProperties(pqarrow.WithAllocator(mem))
	fw, err := pqarrow.NewFileWriter(schema, buf, props, arrowProps)
	if err != nil {
		return nil, err
	}

	for _, rec := range records {
		if err := fw.Write(rec); err != nil {
			return nil, err
		}
	}

	if err := fw.Close(); err != nil {
		return nil, err
	}

	return buf, nil
}

// serializeTruncated writes records to Parquet, stopping after targetRows.
func serializeTruncated(schema *arrow.Schema, records []arrow.Record, targetRows int64) (*bytes.Buffer, int64, error) {
	mem := memory.NewGoAllocator()
	buf := new(bytes.Buffer)

	props := parquet.NewWriterProperties(parquet.WithCompression(compress.Codecs.Snappy))
	arrowProps := pqarrow.NewArrowWriterProperties(pqarrow.WithAllocator(mem))
	fw, err := pqarrow.NewFileWriter(schema, buf, props, arrowProps)
	if err != nil {
		return nil, 0, err
	}

	var written int64
	for _, rec := range records {
		remaining := targetRows - written
		if remaining <= 0 {
			break
		}
		if rec.NumRows() <= remaining {
			if err := fw.Write(rec); err != nil {
				return nil, 0, err
			}
			written += rec.NumRows()
		} else {
			// Slice the record to only include the rows we need
			sliced := rec.NewSlice(0, remaining)
			if err := fw.Write(sliced); err != nil {
				sliced.Release()
				return nil, 0, err
			}
			sliced.Release()
			written += remaining
		}
	}

	if err := fw.Close(); err != nil {
		return nil, 0, err
	}

	return buf, written, nil
}

// --- R2 upload code below is kept for future "materialize on canvas" feature ---
// It is intentionally unreachable from Execute().
//
// func uploadToR2(t Transport, req QueryRequest, buf *bytes.Buffer) (*ExecuteResult, error) {
// 	fullUrl, _, err := t.GetR2PresignedURL(req.ShapeId)
// 	if err != nil {
// 		return nil, fmt.Errorf("failed to get presigned URL: %w", err)
// 	}
//
// 	reqStore, err := http.NewRequest("PUT", fullUrl, bytes.NewReader(buf.Bytes()))
// 	if err != nil {
// 		return nil, fmt.Errorf("failed to create upload request: %w", err)
// 	}
//
// 	resp, err := http.DefaultClient.Do(reqStore)
// 	if err != nil {
// 		return nil, fmt.Errorf("R2 upload failed: %w", err)
// 	}
// 	defer resp.Body.Close()
//
// 	if resp.StatusCode >= 300 {
// 		bodyBytes, _ := io.ReadAll(resp.Body)
// 		return nil, fmt.Errorf("R2 upload rejected (HTTP %d): %s", resp.StatusCode, string(bodyBytes))
// 	}
//
// 	result := &ExecuteResult{UsedR2: true}
//
// 	err = t.SendJSON(map[string]interface{}{
// 		"type": "r2_reference",
// 		"payload": map[string]string{
// 			"download_url": fullUrl,
// 			"shapeId":      req.ShapeId,
// 		},
// 	})
// 	return result, err
// }
