import { backendRevision } from "../client/backendCompute";
import type { Editor } from "tldraw";
import type { LocalServerContextType } from "../client/localServer/types";
import { MissingQueryResultError } from "../client/localServer/types";
import { getRemoteSourceMetadata } from "../DataSource/remote-source-metadata";
import type { SQLTextAreaShape } from "./sql-text-area-types";
import { prepareCanvasSQL } from "./prepareCanvasSQL";

export interface RestoredRemoteQueryMetadata {
  rowCount: number;
  schema: { name: string; type: string }[];
  sampleRows: Record<string, unknown>[];
}

const pendingRestorations = new Map<string, Promise<RestoredRemoteQueryMetadata>>();
const restoredMetadata = new Map<string, RestoredRemoteQueryMetadata>();

export function getRestoredRemoteQueryMetadata(shapeId: string): RestoredRemoteQueryMetadata | null {
  return restoredMetadata.get(shapeId) ?? null;
}

export function clearRestoredRemoteQueryMetadata(shapeId: string): void {
  restoredMetadata.delete(shapeId);
}

export function restoreRemoteQueryView(
  editor: Editor,
  queryShape: SQLTextAreaShape,
  runRemoteQuery: LocalServerContextType["runRemoteQuery"]
): Promise<RestoredRemoteQueryMetadata> {
  const pending = pendingRestorations.get(queryShape.id);
  if (pending) return pending;

  const revision = backendRevision.get();
  const operation = (async () => {
    const currentShape = editor.getShape<SQLTextAreaShape>(queryShape.id);
    if (!currentShape) {
      throw new Error("The query for this result no longer exists.");
    }
    if (currentShape.props.isDirty || !currentShape.props.lastRunStats) {
      throw new MissingQueryResultError(
        "This result is not loaded, and its query has changed since the last run. Run the query manually to load it."
      );
    }

    const prepared = await prepareCanvasSQL(editor, currentShape.props.text);
    const { executionState, orderedDependencies } = prepared;
    const readsBigQuery = orderedDependencies.some(
      (dependency) =>
        dependency.type === "data-source" &&
        getRemoteSourceMetadata(dependency)?.sourceType?.toLowerCase() === "bigquery"
    );
    if (readsBigQuery) {
      throw new MissingQueryResultError(
        "This BigQuery result is not loaded. Kavla does not rerun BigQuery queries automatically because they may incur costs. Run the query manually to load it."
      );
    }
    const result = await runRemoteQuery({
      sql: prepared.sql,
      sourceName: executionState.sourceName,
      sourceType: executionState.sourceType,
      shapeId: currentShape.id,
      queryName: currentShape.props.name,
      sourceNative: executionState.sourceNativePreview,
      restore: true,
    });
    if (backendRevision.get() !== revision)
      throw new MissingQueryResultError("The backend session changed. Reload this result.");
    restoredMetadata.set(currentShape.id, result);
    return result;
  })();

  pendingRestorations.set(queryShape.id, operation);
  const clearPending = () => {
    if (pendingRestorations.get(queryShape.id) === operation) {
      pendingRestorations.delete(queryShape.id);
    }
  };
  void operation.then(clearPending, clearPending);
  return operation;
}

export function clearRestoredQueryResults(): void {
  pendingRestorations.clear();
  restoredMetadata.clear();
}

if (typeof window !== "undefined") window.addEventListener("kavla:backend-reset", clearRestoredQueryResults);
