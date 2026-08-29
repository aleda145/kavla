package transport

import (
	"fmt"
	"strings"

	"github.com/aleda145/kavla/cli/internal/runner"
)

type GetSourceTablesMessage struct {
	RequestID  string
	SourceName string
}

type GetSourceSchemaMessage struct {
	RequestID string
	TableRef  string
}

type GetSourceStatsMessage struct {
	RequestID string
	TableRef  string
}

type CancelQueryMessage struct {
	ShapeID   string
	QueryName string
}

func ParseGetSourceTablesMessage(msg map[string]interface{}) (*GetSourceTablesMessage, error) {
	requestID, _ := msg["requestId"].(string)
	payload, ok := msg["payload"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing payload")
	}

	sourceName, _ := payload["sourceName"].(string)
	return &GetSourceTablesMessage{
		RequestID:  requestID,
		SourceName: sourceName,
	}, nil
}

func ParseGetSourceSchemaMessage(msg map[string]interface{}) (*GetSourceSchemaMessage, error) {
	requestID, _ := msg["requestId"].(string)
	payload, ok := msg["payload"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing payload")
	}

	tableRef, ok := payload["tableRef"].(string)
	if !ok || tableRef == "" {
		return nil, fmt.Errorf("missing tableRef")
	}

	return &GetSourceSchemaMessage{
		RequestID: requestID,
		TableRef:  tableRef,
	}, nil
}

func ParseGetSourceStatsMessage(msg map[string]interface{}) (*GetSourceStatsMessage, error) {
	requestID, _ := msg["requestId"].(string)
	payload, ok := msg["payload"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing payload")
	}

	tableRef, ok := payload["tableRef"].(string)
	if !ok || tableRef == "" {
		return nil, fmt.Errorf("missing tableRef")
	}

	return &GetSourceStatsMessage{
		RequestID: requestID,
		TableRef:  tableRef,
	}, nil
}

func ParseCancelQueryMessage(msg map[string]interface{}) (*CancelQueryMessage, error) {
	payload, ok := msg["payload"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing payload")
	}

	shapeID, ok := payload["shapeId"].(string)
	if !ok || shapeID == "" {
		return nil, fmt.Errorf("missing shapeId")
	}

	queryName, _ := payload["queryName"].(string)

	return &CancelQueryMessage{
		ShapeID:   shapeID,
		QueryName: queryName,
	}, nil
}

func ParseQueryRequestMessage(msg map[string]interface{}) (runner.QueryRequest, error) {
	payload, ok := msg["payload"].(map[string]interface{})
	if !ok {
		return runner.QueryRequest{}, fmt.Errorf("missing payload")
	}

	sql, ok := payload["sql"].(string)
	if !ok || sql == "" {
		return runner.QueryRequest{}, fmt.Errorf("missing sql")
	}

	shapeID, ok := payload["shapeId"].(string)
	if !ok || shapeID == "" {
		return runner.QueryRequest{}, fmt.Errorf("missing shapeId")
	}

	sourceName, _ := payload["sourceName"].(string)
	executionEngine, _ := payload["executionEngine"].(string)
	sourceName = strings.TrimSpace(sourceName)
	executionEngine = strings.TrimSpace(executionEngine)
	if executionEngine != "" && sourceName == "" {
		return runner.QueryRequest{}, fmt.Errorf("sourceName is required when executionEngine is set")
	}
	queryName, _ := payload["queryName"].(string)
	resultFormatValue, _ := payload["resultFormat"].(string)
	resultFormat := runner.ResultFormat(strings.TrimSpace(resultFormatValue))
	if resultFormat != "" && resultFormat != runner.ResultFormatArrow && resultFormat != runner.ResultFormatParquet {
		return runner.QueryRequest{}, fmt.Errorf("unsupported resultFormat %q", resultFormatValue)
	}
	mountedFileSources, err := parseMountedFileSources(payload["mountedFileSources"])
	if err != nil {
		return runner.QueryRequest{}, err
	}
	transient := false
	if rawTransient, present := payload["transient"]; present {
		var ok bool
		transient, ok = rawTransient.(bool)
		if !ok {
			return runner.QueryRequest{}, fmt.Errorf("transient must be a boolean")
		}
	}

	return runner.QueryRequest{
		SQL:                sql,
		ShapeId:            shapeID,
		SourceName:         sourceName,
		ExecutionEngine:    executionEngine,
		MountedFileSources: mountedFileSources,
		QueryName:          queryName,
		ResultFormat:       resultFormat,
		Transient:          transient,
	}, nil
}

func parseMountedFileSources(raw any) ([]runner.MountedFileSource, error) {
	if raw == nil {
		return nil, nil
	}

	items, ok := raw.([]interface{})
	if !ok {
		return nil, fmt.Errorf("mountedFileSources must be an array")
	}

	sources := make([]runner.MountedFileSource, 0, len(items))
	for _, item := range items {
		candidate, ok := item.(map[string]interface{})
		if !ok {
			return nil, fmt.Errorf("mountedFileSources entries must be objects")
		}

		sourceName, _ := candidate["sourceName"].(string)
		blobID, _ := candidate["blobId"].(string)
		r2ObjectKey, _ := candidate["r2ObjectKey"].(string)
		fileName, _ := candidate["fileName"].(string)

		sourceName = strings.TrimSpace(sourceName)
		blobID = strings.TrimSpace(blobID)
		r2ObjectKey = strings.TrimSpace(r2ObjectKey)
		fileName = strings.TrimSpace(fileName)
		if sourceName == "" || (blobID == "" && r2ObjectKey == "") || fileName == "" {
			return nil, fmt.Errorf("mountedFileSources entries require sourceName, fileName, and either blobId or r2ObjectKey")
		}
		if blobID != "" && r2ObjectKey != "" {
			return nil, fmt.Errorf("mountedFileSources entries cannot contain both blobId and r2ObjectKey")
		}

		sources = append(sources, runner.MountedFileSource{
			SourceName:  sourceName,
			BlobID:      blobID,
			R2ObjectKey: r2ObjectKey,
			FileName:    fileName,
		})
	}

	return sources, nil
}
