import type { Editor } from "tldraw";
import { backendRequest, backendRevision, withBackendActivity } from "../client/backendCompute";
import { rememberUploadedBlob, type KavlaBlobDescriptor } from "../client/local/localSession";
import { getOrderedDependenciesForSQL } from "../SQLTextArea/sqlDependencies";
import type { DataSourceShape } from "./data-source-types";
import { getRemoteSourceMetadata, type RemoteSourceMetadata } from "./remote-source-metadata";
import { estimateQuery, type QueryEstimate } from "../client/queryEstimate";
import { quoteDottedIdentifier } from "../src/duckdb/sql";

function usesNativeSampling(shape: DataSourceShape): boolean {
  const type = getRemoteSourceMetadata(shape)?.sourceType;
  return type === "postgres" || type === "bigquery";
}

export function getSampleTable(shape: DataSourceShape): string | undefined {
  // Remote sources run natively, including documents with older saved samples.
  if (usesNativeSampling(shape)) return undefined;
  const percent = shape.props.samplePercent ?? 100;
  const table = percent > 0 && percent < 100 ? shape.props.sampleTables?.[String(percent)] : undefined;
  return table;
}

export function needsSavedSourceSample(shape: DataSourceShape): boolean {
  if (usesNativeSampling(shape)) return false;
  const percent = shape.props.samplePercent ?? 100;
  return percent > 0 && percent < 100 && !getSampleTable(shape);
}

export function getDataSourceExecutionMetadata(shape: DataSourceShape): RemoteSourceMetadata | null {
  const table = getSampleTable(shape);
  const source = getRemoteSourceMetadata(shape);
  return table ? { sourceName: "uploaded_files", sourceType: "duckdb", remoteTableRef: table } : source;
}

export function buildBigQuerySampleSQL(tableRef: string, percent: number): string {
  return `SELECT * FROM ${quoteDottedIdentifier(tableRef)} TABLESAMPLE SYSTEM (${percent} PERCENT)`;
}

export function estimateSourceSample(tableRef: string, percent: number): Promise<QueryEstimate> {
  return estimateQuery({
    sql: buildBigQuerySampleSQL(tableRef, percent),
    sourceName: tableRef.split(".")[0],
    sourceType: "bigquery",
    sourceNative: true,
  });
}

export async function selectSourceSample(
  editor: Editor,
  shape: DataSourceShape,
  percent: number,
  signal?: AbortSignal
): Promise<void> {
  const tableRef = shape.props.remoteTableRef;
  if (!tableRef) throw new Error("The data source is unavailable.");
  if (percent === 100 || percent === 0 || usesNativeSampling(shape)) {
    editor.updateShape<DataSourceShape>({ id: shape.id, type: "data-source", props: { samplePercent: percent } });
    return;
  }
  const revision = backendRevision.get();
  const result = await withBackendActivity(async () => {
    const response = await backendRequest("/api/session/source-sample", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tableRef, percent }),
      signal,
    });
    return (await response.json()) as { tableRef: string; blob?: KavlaBlobDescriptor };
  });
  if (backendRevision.get() !== revision) throw new Error("The document changed while creating the sample.");
  if (result.blob) rememberUploadedBlob(result.blob);
  const current = editor.getShape<DataSourceShape>(shape.id);
  if (
    !current ||
    current.props.remoteTableRef !== tableRef ||
    current.props.samplePercent !== shape.props.samplePercent
  ) {
    throw new Error("The data source changed while creating the sample.");
  }
  editor.updateShape<DataSourceShape>({
    id: shape.id,
    type: "data-source",
    props: {
      samplePercent: percent,
      sampleTables: { ...current.props.sampleTables, [String(percent)]: result.tableRef },
    },
  });
}

// Older documents have a percentage but no saved sample yet. Build it on an
// explicit query run, never during validation or an automatic result restore.
export async function ensureQuerySamples(editor: Editor, sql: string, signal?: AbortSignal): Promise<void> {
  for (const dependency of getOrderedDependenciesForSQL(editor, sql).orderedDependencies) {
    if (dependency.type !== "data-source") continue;
    const percent = dependency.props.samplePercent ?? 100;
    if (needsSavedSourceSample(dependency)) {
      await selectSourceSample(editor, dependency, percent, signal);
    }
  }
}

export function forgetSourceSample(editor: Editor, tableRef: string): void {
  for (const record of Object.values(editor.store.serialize("document"))) {
    if (record.typeName !== "shape" || record.type !== "data-source") continue;
    const shape = record as DataSourceShape;
    const entries = Object.entries(shape.props.sampleTables ?? {});
    if (!entries.some(([, table]) => table === tableRef)) continue;
    editor.updateShape<DataSourceShape>({
      id: shape.id,
      type: "data-source",
      props: { sampleTables: Object.fromEntries(entries.filter(([, table]) => table !== tableRef)) },
    });
  }
}
