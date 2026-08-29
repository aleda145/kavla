package transport

import (
	"strings"
	"testing"

	"github.com/aleda145/kavla/cli/internal/runner"
)

func TestParseQueryRequestMessageAllowsMissingExecutionEngine(t *testing.T) {
	req, err := ParseQueryRequestMessage(map[string]interface{}{
		"payload": map[string]interface{}{
			"sql":     "SELECT 1",
			"shapeId": "shape-1",
		},
	})
	if err != nil {
		t.Fatalf("ParseQueryRequestMessage returned error: %v", err)
	}

	if req.ExecutionEngine != "" {
		t.Fatalf("expected empty execution engine, got %q", req.ExecutionEngine)
	}
}

func TestParseQueryRequestMessageParsesParquetResultFormat(t *testing.T) {
	req, err := ParseQueryRequestMessage(map[string]interface{}{
		"payload": map[string]interface{}{
			"sql":          "SELECT 1",
			"shapeId":      "shape-1",
			"resultFormat": "parquet",
		},
	})
	if err != nil {
		t.Fatalf("ParseQueryRequestMessage returned error: %v", err)
	}

	if req.ResultFormat != runner.ResultFormatParquet {
		t.Fatalf("expected Parquet result format, got %q", req.ResultFormat)
	}
}

func TestParseQueryRequestMessageParsesTransientResult(t *testing.T) {
	req, err := ParseQueryRequestMessage(map[string]interface{}{
		"payload": map[string]interface{}{
			"sql":       "SELECT 1",
			"shapeId":   "hover-stats-1",
			"transient": true,
		},
	})
	if err != nil {
		t.Fatalf("ParseQueryRequestMessage returned error: %v", err)
	}
	if !req.Transient {
		t.Fatal("expected transient query result")
	}
}

func TestParseQueryRequestMessageRejectsUnknownResultFormat(t *testing.T) {
	_, err := ParseQueryRequestMessage(map[string]interface{}{
		"payload": map[string]interface{}{
			"sql":          "SELECT 1",
			"shapeId":      "shape-1",
			"resultFormat": "csv",
		},
	})
	if err == nil {
		t.Fatal("expected an error for an unsupported result format")
	}
}

func TestParseQueryRequestMessageRequiresSourceNameForExecutionEngine(t *testing.T) {
	_, err := ParseQueryRequestMessage(map[string]interface{}{
		"payload": map[string]interface{}{
			"sql":             "SELECT 1",
			"shapeId":         "shape-1",
			"executionEngine": "bigquery",
		},
	})
	if err == nil {
		t.Fatal("expected an error when executionEngine is set without sourceName")
	}

	if !strings.Contains(err.Error(), "sourceName is required") {
		t.Fatalf("expected sourceName validation error, got %v", err)
	}
}

func TestParseQueryRequestMessageParsesMountedFileSources(t *testing.T) {
	req, err := ParseQueryRequestMessage(map[string]interface{}{
		"payload": map[string]interface{}{
			"sql":     "SELECT * FROM orders",
			"shapeId": "shape-1",
			"mountedFileSources": []interface{}{
				map[string]interface{}{
					"sourceName": "orders",
					"blobId":     "source:orders",
					"fileName":   "orders.parquet",
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("ParseQueryRequestMessage returned error: %v", err)
	}

	if len(req.MountedFileSources) != 1 {
		t.Fatalf("expected 1 mounted file source, got %d", len(req.MountedFileSources))
	}

	mounted := req.MountedFileSources[0]
	if mounted.SourceName != "orders" || mounted.BlobID != "source:orders" || mounted.FileName != "orders.parquet" {
		t.Fatalf("unexpected mounted file source: %+v", mounted)
	}
}

func TestParseQueryRequestMessageParsesHostedMountedFileSources(t *testing.T) {
	req, err := ParseQueryRequestMessage(map[string]interface{}{
		"payload": map[string]interface{}{
			"sql":     "SELECT * FROM orders",
			"shapeId": "shape-1",
			"mountedFileSources": []interface{}{
				map[string]interface{}{
					"sourceName":  "orders",
					"r2ObjectKey": "rooms/room-1/orders.parquet",
					"fileName":    "orders.parquet",
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("ParseQueryRequestMessage returned error: %v", err)
	}

	mounted := req.MountedFileSources[0]
	if mounted.SourceName != "orders" || mounted.R2ObjectKey != "rooms/room-1/orders.parquet" || mounted.BlobID != "" {
		t.Fatalf("unexpected hosted mounted file source: %+v", mounted)
	}
}

func TestParseQueryRequestMessageRejectsAmbiguousMountedFileSource(t *testing.T) {
	_, err := ParseQueryRequestMessage(map[string]interface{}{
		"payload": map[string]interface{}{
			"sql":     "SELECT * FROM orders",
			"shapeId": "shape-1",
			"mountedFileSources": []interface{}{
				map[string]interface{}{
					"sourceName":  "orders",
					"blobId":      "source:orders",
					"r2ObjectKey": "rooms/room-1/orders.parquet",
					"fileName":    "orders.parquet",
				},
			},
		},
	})
	if err == nil {
		t.Fatal("expected ambiguous file source to be rejected")
	}
}
