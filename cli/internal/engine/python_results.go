package engine

import (
    "context"
    "fmt"
    "strings"
)

// BindResults supplies canvas aliases without exposing physical result names to clients.
func (e *Engine) BindResults(query string, bindings map[string]string) string {
    if len(bindings) == 0 { return query }
    aliases := []string{}
    for name, id := range bindings {
        aliases = append(aliases, fmt.Sprintf("%s AS (SELECT * FROM %s)", quoteIdentifier(name), quoteIdentifier(resultTableName(id))))
    }
    // Nest the user's query so its own WITH clause remains valid.
    return "WITH " + strings.Join(aliases, ", ") + " SELECT * FROM (" + strings.TrimSuffix(strings.TrimSpace(query), ";") + ") AS _kavla_query"
}

func (e *Engine) PublishParquetResult(ctx context.Context, id, path string) (int64, []ResultColumn, error) {
    query := "SELECT * FROM read_parquet(" + sqlStringLiteral(path) + ")"
    // Validate using a staging view before replacing the last successful result.
    staging := id + ":staging"
    if err := e.CreateResultView(ctx, staging, query); err != nil { return 0, nil, err }
    defer e.DropResult(context.Background(), staging)
    count, err := e.ResultRowCount(ctx, staging); if err != nil { return 0, nil, err }
    schema, err := e.ResultSchema(ctx, staging); if err != nil { return 0, nil, err }
    if err := e.CreateResultView(ctx, id, query); err != nil { return 0, nil, err }
    return count, schema, nil
}
