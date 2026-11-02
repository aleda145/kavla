package compute

import (
	"context"

	"github.com/aleda145/kavla/cli/internal/engine"
	"github.com/apache/arrow/go/v14/arrow/array"
)

func (c *Client) Query(ctx context.Context, sql string) (array.RecordReader, error) {
	return c.query(ctx, request{Op: "query", SQL: sql})
}

func (c *Client) QueryResultPage(ctx context.Context, id string, offset, limit int) (array.RecordReader, error) {
	return c.query(ctx, request{Op: "page", ID: id, Offset: offset, Limit: limit})
}

func (c *Client) QueryWidget(ctx context.Context, sql, name string, columns []engine.WidgetColumn, rows [][]interface{}) (array.RecordReader, error) {
	return c.query(ctx, request{Op: "widget", SQL: sql, ID: name, Columns: columns, Rows: rows})
}

func (c *Client) PreparePreviewSQL(executionEngine, source, sql string, limit int) (string, error) {
	result, err := c.call(c.ctx, request{Op: "preview", ExecutionEngine: executionEngine, Source: source, SQL: sql, Limit: limit})
	return result.SQL, err
}

func (c *Client) PrepareRemoteFileMountSQL(source, fileName, path string) (string, error) {
	result, err := c.call(c.ctx, request{Op: "prepare-mount", Source: source, FileName: fileName, Path: path})
	return result.SQL, err
}

func (c *Client) MountRemoteFileSource(ctx context.Context, source, fileName, path string) error {
	_, err := c.call(ctx, request{Op: "mount", Source: source, FileName: fileName, Path: path})
	return err
}

func (c *Client) CreateResultView(ctx context.Context, id, sql string) error {
	_, err := c.call(ctx, request{Op: "create-view", ID: id, SQL: sql})
	return err
}

func (c *Client) ResultRowCount(ctx context.Context, id string) (int64, error) {
	result, err := c.call(ctx, request{Op: "count", ID: id})
	return result.Count, err
}

func (c *Client) ResultSchema(ctx context.Context, id string) ([]engine.ResultColumn, error) {
	result, err := c.call(ctx, request{Op: "schema", ID: id})
	return result.Schema, err
}

func (c *Client) ExportResult(ctx context.Context, id, format, path string) error {
	_, err := c.call(ctx, request{Op: "export-result", ID: id, Format: format, Path: path})
	return err
}

func (c *Client) DropResult(ctx context.Context, id string) error {
	_, err := c.call(ctx, request{Op: "drop-view", ID: id})
	return err
}

func (c *Client) GetTables(source string) ([]string, error) {
	result, err := c.call(c.ctx, request{Op: "tables", Source: source})
	return result.Tables, err
}

func (c *Client) DescribeTable(ctx context.Context, source string) ([]map[string]string, error) {
	result, err := c.call(ctx, request{Op: "describe", Source: source})
	return result.Columns, err
}

func (c *Client) GetSourceStats(ctx context.Context, source string) (map[string]int64, error) {
	result, err := c.call(ctx, request{Op: "stats", Source: source})
	return result.Stats, err
}

func (c *Client) ExportSourceTable(ctx context.Context, source, format, path string) error {
	_, err := c.call(ctx, request{Op: "export-source", Source: source, Format: format, Path: path})
	return err
}

func (c *Client) ImportUploadedFile(ctx context.Context, name, fileName, path string) error {
	_, err := c.call(ctx, request{Op: "import", ID: name, FileName: fileName, Path: path})
	return err
}

func (c *Client) DropUploadedFile(ctx context.Context, name string) error {
	_, err := c.call(ctx, request{Op: "drop-upload", ID: name})
	return err
}

func (c *Client) ValidateQuery(ctx context.Context, sql string) error {
	_, err := c.call(ctx, request{Op: "validate", SQL: sql})
	return err
}
