import type { Editor, TLShapeId } from "tldraw";
import type { ChartShape } from "../chart-shape-types";
import type { SQLTextAreaShape } from "../../SQLTextArea/sql-text-area-types";
import { buildRemoteSQLFromDag, walkSQLDag } from "../../SQLTextArea/walkSQLDag";
import { identifier } from "./selection";
import { getRemoteSourceMetadata } from "../../DataSource/remote-source-metadata";

export function scatterSource(editor: Editor, chart: ChartShape) {
  const source = chart.props.sourceShapeId ? editor.getShape(chart.props.sourceShapeId as TLShapeId) : undefined;
  if (source?.type !== "sql-text-area") throw new Error("Connect this chart to a SQL query.");
  const query = source as SQLTextAreaShape;
  const reference = `SELECT * FROM ${identifier(query.props.name)}`;
  const result = walkSQLDag(editor, reference);
  if (!result.ok) throw new Error(result.error.message);
  const { orderedDependencies } = result.plan;
  // Native remote dialects cannot safely be wrapped in a DuckDB polygon query.
  // Avoid automatically re-running potentially chargeable BigQuery queries.
  const canSelect = !orderedDependencies.some(
    (d) =>
      d.type === "data-source" &&
      !["duckdb", "csv", "parquet", "directory"].includes(getRemoteSourceMetadata(d)?.sourceType ?? "")
  );
  for (const dependency of orderedDependencies) {
    if (
      dependency.type === "sql-text-area" &&
      (dependency.props.isDirty || dependency.props.isRunning || !dependency.props.lastRunStats)
    )
      throw new Error(`Run "${dependency.props.name}" before plotting or selecting its data.`);
  }
  const expanded = buildRemoteSQLFromDag(reference, orderedDependencies, editor);
  // Match the CLI's existing result-view naming contract. Querying this view
  // preserves the prepared native/federated execution route and document session.
  const resultId = query.id.replaceAll("'", "''");
  const resultSQL = `SELECT * FROM query_table('_kavla_result_' || substr(sha256('${resultId}'), 1, 32))`;
  const limit = chart.props.limit;
  const sql = limit === null ? resultSQL : `${resultSQL} LIMIT ${Math.max(1, Math.floor(limit))}`;
  return {
    id: query.id,
    name: query.props.name,
    sql,
    canSelect: canSelect && !/\b(?:bigquery_query|postgres_query)\s*\(/i.test(expanded),
    revision: JSON.stringify([
      expanded,
      orderedDependencies.map((d) => (d.type === "sql-text-area" ? d.props.lastRunStats : getRemoteSourceMetadata(d))),
      ...(limit === null ? [] : [limit]),
      // Runtime and row count can be identical on two runs with different data.
      // Preserve legacy revision strings until a query receives its first token.
      ...orderedDependencies.flatMap((d) =>
        d.type === "sql-text-area" && typeof d.meta.nativeQueryRevision === "string"
          ? [[d.id, d.meta.nativeQueryRevision]]
          : []
      ),
    ]),
    schema: query.props.outputSchema ?? [],
  };
}
