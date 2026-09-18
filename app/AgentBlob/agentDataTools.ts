import type { Editor, TLShapeId } from "tldraw";
import type { DataSourceShape } from "../DataSource/data-source-types";
import type { SQLTextAreaShape } from "../SQLTextArea/sql-text-area-types";
import type { CodexToolEnvironment } from "../client/localServer/codexRuns";
import { DuckDBService } from "../src/duckdb-service";
import { quoteIdentifier } from "../src/duckdb/sql";
import { buildColumnStatsQuery, parseColumnStatsRows } from "../src/duckdb/column-stats-sql";
import type { ColumnStats } from "../src/duckdb/column-stats-types";
import { walkSQLDag, buildRemoteSQLFromDag } from "../SQLTextArea/walkSQLDag";
import { loadSQLDagDependencies, ensureLocalQueryView } from "../SQLTextArea/sqlDagDependencies";

export function resolveAgentDataShape(editor: Editor, shapeId: string): DataSourceShape | SQLTextAreaShape {
  const seen = new Set<string>();
  let shape = editor.getShape(shapeId as TLShapeId);
  while (shape && !seen.has(shape.id)) {
    seen.add(shape.id);
    if (shape.type === "data-source" || shape.type === "sql-text-area") return shape as DataSourceShape | SQLTextAreaShape;
    shape = "sourceShapeId" in shape.props && typeof shape.props.sourceShapeId === "string" ? editor.getShape(shape.props.sourceShapeId as TLShapeId) : undefined;
  }
  throw new Error("Choose a data source or a connected query, table, chart, or Lens.");
}

export async function getAgentDataPreview(editor: Editor, shapeId: string, data: CodexToolEnvironment["data"], limit = 5): Promise<Record<string, unknown>[]> {
  const shape = resolveAgentDataShape(editor, shapeId);
  if (shape.type !== "sql-text-area") throw new Error("Create a visible query to preview this source.");
  if (shape.props.isDirty || shape.props.stale || shape.props.error || !shape.props.lastRunStats) throw new Error("Run the source query first.");
  if (shape.props.lastRunStats.runnerName === "CLI") return (await data.getQueryResultPage({ shapeId: shape.id, offset: 0, limit })).rows;
  await ensureLocalQueryView(editor, shape);
  const connection = await DuckDBService.getInstance().getDb()!.connect();
  try {
    return (await connection.query(`SELECT * FROM ${quoteIdentifier(shape.props.name)} LIMIT ${Math.max(1, Math.min(10001, Math.floor(limit)))}`)).toArray().map((row) => row.toJSON() as Record<string, unknown>);
  } finally { await connection.close(); }
}

export async function computeAgentProfiles(editor: Editor, args: Record<string, unknown>, env: CodexToolEnvironment): Promise<Record<string, unknown>> {
  const shape = resolveAgentDataShape(editor, String(args.shapeId || ""));
  if (shape.type === "sql-text-area" && (shape.props.isDirty || shape.props.stale || shape.props.error)) throw new Error("Run this visible query before profiling its output.");
  const schema = (shape.type === "data-source" ? shape.props.metadata : shape.props.outputSchema) || [];
  const columns = Array.isArray(args.columns) ? args.columns : schema.slice(0, 12).map((column) => column.name);
  if (!columns.length || columns.length > 20) throw new Error("Choose between 1 and 20 columns to profile.");
  const selected = [...new Set(columns)].map((name) => {
    const column = schema.find((column) => column.name === name);
    if (!column) throw new Error(`Unknown column ${String(name)}.`);
    return column;
  });
  const plan = walkSQLDag(editor, `SELECT * FROM ${quoteIdentifier(shape.props.name)}`);
  if (!plan.ok) throw new Error(plan.error.message);
  const { orderedDependencies, executionState, mountedFileSources } = plan.plan;
  await loadSQLDagDependencies(orderedDependencies, { mode: "execution", isRemoteExecution: executionState.isRemoteExecution });
  const profiles: Record<string, ColumnStats> = {};
  for (const column of selected) {
    env.signal.throwIfAborted();
    const table = quoteIdentifier(shape.props.name);
    const col = quoteIdentifier(column.name);
    const { sql, analysisType } = buildColumnStatsQuery({ quotedTable: table, quotedColumn: col, columnType: column.type, sourceType: executionState.sourceNativePreview ? executionState.sourceType : null });
    let rows: Record<string, unknown>[];
    if (executionState.isRemoteExecution) {
      const requestId = `agent-profile:${crypto.randomUUID()}`;
      const cancel = () => env.data.cancelRemoteQuery(requestId);
      env.signal.addEventListener("abort", cancel, { once: true });
      try {
        // Pack the profile into one preview row so histogram buckets are never truncated by the CLI preview limit.
        const sourceType = executionState.sourceNativePreview ? executionState.sourceType : null;
        const aggregate = sourceType === "postgres" ? "json_agg(kavla_profile)" : sourceType === "bigquery" ? "TO_JSON_STRING(ARRAY_AGG(kavla_profile))" : "to_json(list(kavla_profile))";
        const packedSQL = `SELECT ${aggregate} AS profile_rows FROM (${sql}) AS kavla_profile`;
        const response = await env.data.runRemoteQuery({ sql: buildRemoteSQLFromDag(packedSQL, orderedDependencies), sourceName: executionState.sourceName, sourceType: executionState.sourceType, sourceNative: executionState.sourceNativePreview, mountedFileSources, shapeId: requestId, transient: true });
        const packed = response.sampleRows[0]?.profile_rows;
        const decoded: unknown = typeof packed === "string" ? JSON.parse(packed) : packed;
        if (!Array.isArray(decoded)) throw new Error("The server returned an invalid column profile.");
        rows = decoded as Record<string, unknown>[];
      } finally { env.signal.removeEventListener("abort", cancel); }
    } else {
      const connection = await DuckDBService.getInstance().getDb()!.connect();
      const cancel = () => { void connection.cancelSent(); };
      env.signal.addEventListener("abort", cancel, { once: true });
      try {
        rows = [];
        for await (const batch of await connection.send(sql)) rows.push(...batch.toArray().map((row) => row.toJSON() as Record<string, unknown>));
      } finally { env.signal.removeEventListener("abort", cancel); await connection.close(); }
    }
    env.signal.throwIfAborted();
    const profile = JSON.parse(JSON.stringify(parseColumnStatsRows(analysisType, rows), (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)) as ColumnStats;
    profiles[column.name] = profile;
    const current = editor.getShape<DataSourceShape | SQLTextAreaShape>(shape.id);
    if (!current || current.props.name !== shape.props.name || (shape.type === "sql-text-area" && current.type === "sql-text-area" && (current.props.text !== shape.props.text || current.props.isDirty || current.props.stale))) throw new Error("The source changed while profiling it.");
    editor.updateShape<DataSourceShape | SQLTextAreaShape>({ id: shape.id, type: shape.type, props: { columnStats: { ...current.props.columnStats, ...profiles } } });
  }
  return { ok: true, shapeId: shape.id, profiles, profileScope: "Full source/query output, including distributions." };
}
