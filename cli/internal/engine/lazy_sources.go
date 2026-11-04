package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	"github.com/duckdb/duckdb-go/v2"
)

func (e *Engine) ensureReferencedSources(ctx context.Context, query string) error {
	if len(e.sourceConfigs) == 0 {
		return nil
	}
	// Serialize syntax without binding or executing it. GetTableNames alone
	// misses references in some CTEs when their catalogs are not attached yet.
	var serialized string
	if err := e.db.QueryRowContext(ctx, "SELECT CAST(json_serialize_sql(?) AS VARCHAR)", query).Scan(&serialized); err != nil {
		return fmt.Errorf("inspect query sources: %w", err)
	}
	var parsed struct {
		Error        bool          `json:"error"`
		ErrorType    string        `json:"error_type"`
		ErrorMessage string        `json:"error_message"`
		Statements   []interface{} `json:"statements"`
	}
	if err := json.Unmarshal([]byte(serialized), &parsed); err != nil {
		return fmt.Errorf("decode query sources: %w", err)
	}
	var referenced []string
	if parsed.Error {
		if parsed.ErrorType != "not implemented" {
			return fmt.Errorf("inspect query sources: %s", parsed.ErrorMessage)
		}
		// The JSON serializer supports SELECT statements. Keep other existing
		// SQL operations working through DuckDB's general table-name extractor.
		conn, err := e.db.Conn(ctx)
		if err != nil {
			return err
		}
		tables, err := duckdb.GetTableNames(conn, query, true)
		_ = conn.Close()
		if err != nil {
			return err
		}
		for _, table := range tables {
			referenced = append(referenced, sourceNameFromTableRef(table))
		}
	} else {
		for _, statement := range parsed.Statements {
			collectQuerySources(statement, &referenced)
		}
	}
	slices.Sort(referenced)
	for _, source := range slices.Compact(referenced) {
		if err := e.ensureConfiguredSourceHealthy(ctx, source); err != nil {
			return err
		}
	}
	return nil
}

func collectQuerySources(node interface{}, referenced *[]string) {
	switch value := node.(type) {
	case []interface{}:
		for _, child := range value {
			collectQuerySources(child, referenced)
		}
	case map[string]interface{}:
		if value["type"] == "BASE_TABLE" {
			catalog, _ := value["catalog_name"].(string)
			schema, _ := value["schema_name"].(string)
			if catalog != "" && catalog != "memory" {
				*referenced = append(*referenced, catalog)
			} else if schema != "" {
				*referenced = append(*referenced, schema)
			}
		}
		name, _ := value["function_name"].(string)
		if strings.EqualFold(name, "bigquery_query") || strings.EqualFold(name, "postgres_query") {
			arguments, _ := value["arguments"].([]interface{})
			if len(arguments) > 0 {
				argument, _ := arguments[0].(map[string]interface{})
				expression, _ := argument["expression"].(map[string]interface{})
				literal, _ := expression["literal"].(map[string]interface{})
				if literal["kind"] == "STRING" {
					name, _ := literal["text"].(string)
					*referenced = append(*referenced, name)
				}
			}
		}
		for _, child := range value {
			collectQuerySources(child, referenced)
		}
	}
}
