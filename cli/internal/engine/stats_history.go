package engine

import "context"

func (e *Engine) createStatsHistoryView(ctx context.Context, path string) error {
	if _, err := e.db.ExecContext(ctx, "CREATE SCHEMA IF NOT EXISTS memory.kavla"); err != nil {
		return err
	}
	// Fix the schema even when the first samples describe a sleeping worker.
	_, err := e.db.ExecContext(ctx, `CREATE VIEW memory.kavla.duckdb_stats AS
		SELECT * REPLACE (round(uptime)::BIGINT AS uptime)
		FROM read_json(`+sqlStringLiteral(path)+`, format='newline_delimited', columns={
			'timestamp':'TIMESTAMPTZ', 'state':'VARCHAR', 'pid':'BIGINT', 'uptime':'DOUBLE',
			'memory_allocated':'UBIGINT', 'memory_limit':'UBIGINT', 'threads_limit':'INTEGER',
			'cpu_usage':'DOUBLE', 'error':'VARCHAR'
		})`)
	return err
}
