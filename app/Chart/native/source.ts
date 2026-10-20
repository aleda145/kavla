import type { Editor, TLShapeId } from "tldraw";
import type { ChartShape } from "../chart-shape-types";
import type { SQLTextAreaShape } from "../../SQLTextArea/sql-text-area-types";
import { buildRemoteSQLFromDag, walkSQLDag } from "../../SQLTextArea/walkSQLDag";
import { identifier } from "./selection";
import { getRemoteSourceMetadata } from "../../DataSource/remote-source-metadata";
import { getCliSourcesSnapshot } from "../../client/localServer/runtimeStore";
import { extractTableNames } from "../../util/parseSql";

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
  if (
    orderedDependencies.some(
      (d) =>
        d.type === "data-source" &&
        !["duckdb", "csv", "parquet", "directory"].includes(getRemoteSourceMetadata(d)?.sourceType ?? "")
    )
  ) {
    throw new Error("This prototype requires a DuckDB source. Materialize remote results explicitly before plotting.");
  }
  if (
    result.plan.executionState.sourceNativePreview &&
    !["duckdb", "csv", "parquet", "directory"].includes(result.plan.executionState.sourceType ?? "")
  )
    throw new Error("Native remote queries are not supported by this prototype. Use a DuckDB source.");
  for (const dependency of orderedDependencies) {
    if (
      dependency.type === "sql-text-area" &&
      (dependency.props.isDirty || dependency.props.isRunning || !dependency.props.lastRunStats)
    )
      throw new Error(`Run "${dependency.props.name}" before plotting or selecting its data.`);
  }
  const sql = buildRemoteSQLFromDag(reference, orderedDependencies, editor);
  if (/\b(?:bigquery_query|postgres_query)\s*\(/i.test(sql))
    throw new Error("Native remote query functions require explicit materialization before plotting.");
  for (const table of extractTableNames(sql)) {
    if (!table.includes(".")) continue;
    const catalog = table.split(".")[0];
    if (catalog === "uploaded_files") continue;
    const configured = getCliSourcesSnapshot().find((source) => source.name.toLowerCase() === catalog.toLowerCase());
    if (!configured || !["duckdb", "csv", "parquet", "directory"].includes(configured.type.toLowerCase()))
      throw new Error(`The prototype cannot automatically scan "${catalog}". Use a known DuckDB source.`);
  }
  return {
    id: query.id,
    name: query.props.name,
    sql,
    revision: JSON.stringify([
      sql,
      orderedDependencies.map((d) => (d.type === "sql-text-area" ? d.props.lastRunStats : getRemoteSourceMetadata(d))),
    ]),
    schema: query.props.outputSchema ?? [],
  };
}
