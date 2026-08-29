import type { Editor } from "tldraw";
import type { LocalServerContextType } from "../client/localServer/types";
import { MissingQueryResultError } from "../client/localServer/types";
import { getRemoteSourceMetadata } from "../DataSource/remote-source-metadata";
import type { SQLTextAreaShape } from "./sql-text-area-types";
import { buildRemoteSQLFromDag, walkSQLDag } from "./walkSQLDag";

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

    const dagWalk = walkSQLDag(editor, currentShape.props.text);
    if (!dagWalk.ok) {
      throw new Error(dagWalk.error.message);
    }
    if (!dagWalk.plan.executionState.isRemoteExecution) {
      throw new Error("Only CLI-backed query views can be restored through the Kavla server.");
    }

    const { executionState, mountedFileSources, orderedDependencies } = dagWalk.plan;
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
      sql: buildRemoteSQLFromDag(currentShape.props.text, orderedDependencies),
      sourceName: executionState.sourceName,
      sourceType: executionState.sourceType,
      shapeId: currentShape.id,
      queryName: currentShape.props.name,
      sourceNative: executionState.sourceNativePreview,
      mountedFileSources,
      restore: true,
    });
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
