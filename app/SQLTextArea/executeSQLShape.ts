import { clearRestoredRemoteQueryMetadata } from "./restoreRemoteQueryView";
import { createShapeId, type Editor, type TLShapeId } from "tldraw";
import { canvasSQLSignature } from "../Dbt/dbtCompilation";
import type { SQLTextAreaShape } from "./sql-text-area-types";
import type { LocalServerContextType } from "../client/localServer/types";
import { prepareCanvasSQL } from "./prepareCanvasSQL";
import { connectShapes, setShapeUpstreamConnections } from "../util/shapeConnections";
import { dispatchSQLShapeRunStarted, dispatchSQLShapeRunFinished, type SQLShapeRunResult } from "./sqlShapeRun";
import { ensureQueryKnobs } from "../Knob/createKnobs";

export async function executeSQLShape(
  editor: Editor,
  data: LocalServerContextType,
  id: TLShapeId,
  sql: string,
  signal: AbortSignal,
  options: { createMissingKnobs?: boolean } = {}
): Promise<SQLShapeRunResult> {
  signal.throwIfAborted();
  const shape = editor.getShape<SQLTextAreaShape>(id);
  if (!shape || shape.type !== "sql-text-area") throw new Error("The query shape is unavailable.");
  if (shape.props.dbt?.readOnly)
    throw new Error("This model is a truncated file preview and cannot be run. Open the full file in your editor.");
  if (shape.props.isRunning) throw new Error("This query is already running.");
  if (options.createMissingKnobs !== false) ensureQueryKnobs(editor, shape, sql);
  clearRestoredRemoteQueryMetadata(id);
  const started = Date.now();
  const runnerName = "CLI";
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
    const plan = await prepareCanvasSQL(editor, sql, signal);
    const { executionState, nextUpstreamShapeIds } = plan;
    if (nextUpstreamShapeIds.includes(id)) throw new Error("A query cannot read from its own output.");
    setShapeUpstreamConnections(editor, id, nextUpstreamShapeIds as TLShapeId[]);
    const inputs = canvasSQLSignature(editor);
    const output = await data.runRemoteQuery({
      sql: plan.sql,
      sourceName: executionState.sourceName,
      sourceType: executionState.sourceType,
      sourceNative: executionState.sourceNativePreview,
      shapeId: id,
      queryName: shape.props.name,
    });
    signal.throwIfAborted();
    const current = editor.getShape<SQLTextAreaShape>(id);
    if (!current) throw new Error("The query shape was removed.");
    if (current.props.text !== sql || canvasSQLSignature(editor) !== inputs)
      throw new Error("The query or an upstream input changed while it was running; run it again.");
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
        y: current.y + editor.getShapeGeometry(current).bounds.height + 60,
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
