import { clearRestoredRemoteQueryMetadata } from "./restoreRemoteQueryView";
import { createShapeId, type Editor, type TLShapeId } from "tldraw";
import type { SQLTextAreaShape } from "./sql-text-area-types";
import type { LocalServerContextType } from "../client/localServer/types";
import { walkSQLDag, buildRemoteSQLFromDag } from "./walkSQLDag";
import { connectShapes, setShapeUpstreamConnections } from "../util/shapeConnections";
import { dispatchSQLShapeRunStarted, dispatchSQLShapeRunFinished, type SQLShapeRunResult } from "./sqlShapeRun";

export async function executeSQLShape(
  editor: Editor,
  data: LocalServerContextType,
  id: TLShapeId,
  sql: string,
  signal: AbortSignal
): Promise<SQLShapeRunResult> {
  signal.throwIfAborted();
  const shape = editor.getShape<SQLTextAreaShape>(id);
  if (!shape || shape.type !== "sql-text-area") throw new Error("The query shape is unavailable.");
  if (shape.props.isRunning) throw new Error("This query is already running.");
  clearRestoredRemoteQueryMetadata(id);
  const started = Date.now();
  const plan = walkSQLDag(editor, sql);
  if (!plan.ok) throw new Error(plan.error.message);
  const { executionState, orderedDependencies, nextUpstreamShapeIds } = plan.plan;
  if (nextUpstreamShapeIds.includes(id))
    throw new Error("A query cannot read from its own output. Reference an upstream source or query instead.");
  const runnerName = "CLI";
  setShapeUpstreamConnections(editor, id, nextUpstreamShapeIds as TLShapeId[]);
  editor.updateShape<SQLTextAreaShape>({
    id,
    type: "sql-text-area",
    props: { text: sql, isRunning: true, isDirty: false, error: null, queryStartTime: started, runnerName },
  });
  dispatchSQLShapeRunStarted(id, sql);
  const cancelRemote = () => data.cancelRemoteQuery(id, shape.props.name);
  signal.addEventListener("abort", cancelRemote, { once: true });
  let result: SQLShapeRunResult;
  try {
    signal.throwIfAborted();
    const output = await data.runRemoteQuery({
      sql: buildRemoteSQLFromDag(sql, orderedDependencies),
      sourceName: executionState.sourceName,
      sourceType: executionState.sourceType,
      sourceNative: executionState.sourceNativePreview,
      shapeId: id,
      queryName: shape.props.name,
    });
    signal.throwIfAborted();
    const current = editor.getShape<SQLTextAreaShape>(id);
    if (!current) throw new Error("The query shape was removed.");
    if (current.props.text !== sql)
      throw new Error("The query was edited while the Agent was running it; run the edited query again.");
    editor.updateShape<SQLTextAreaShape>({
      id,
      type: "sql-text-area",
      props: {
        outputSchema: output.schema,
        columnStats: null,
        stale: false,
        lastRunStats: { executionTime: Date.now() - started, rowCount: output.rowCount, runnerName },
      },
    });
    if (
      current.props.showTable &&
      (!current.props.linkedTableId || !editor.getShape(current.props.linkedTableId as TLShapeId))
    ) {
      const tableId = createShapeId();
      editor.createShape({
        id: tableId,
        type: "sql-result-table",
        x: current.x,
        y: current.y + current.props.h + 60,
        props: { sourceShapeId: id, w: 400, h: 300 },
      });
      editor.updateShape<SQLTextAreaShape>({ id, type: "sql-text-area", props: { linkedTableId: tableId } });
      connectShapes(editor, id, tableId);
    }
    result = { success: true, rowCount: output.rowCount, outputSchema: output.schema, sampleRows: output.sampleRows };
  } catch (error) {
    const message = signal.aborted ? "Query cancelled" : error instanceof Error ? error.message : String(error);
    result = { success: false, error: message };
    if (editor.getShape(id))
      editor.updateShape<SQLTextAreaShape>({
        id,
        type: "sql-text-area",
        props: { error: signal.aborted ? null : message, isDirty: true },
      });
  } finally {
    signal.removeEventListener("abort", cancelRemote);
    if (editor.getShape(id))
      editor.updateShape<SQLTextAreaShape>({
        id,
        type: "sql-text-area",
        props: { isRunning: false, queryStartTime: null, runnerName: null },
      });
  }
  dispatchSQLShapeRunFinished(id, result);
  signal.throwIfAborted();
  return result;
}
