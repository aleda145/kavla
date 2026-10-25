import { atom, useValue, type Editor, type TLShapeId } from "tldraw";
import type { SQLTextAreaShape } from "../../SQLTextArea/sql-text-area-types";
import { getSQLBizSize } from "../../SQLTextArea/sqlBizSummary";
import { getAutoExpandedSQLShapeSize } from "../../SQLTextArea/sqlShapeSize";

// A view preference belongs to this editor, never to the saved document.
const modes = new WeakMap<Editor, ReturnType<typeof createMode>>();

function createMode() {
  return atom<{ enabled: boolean; queryModes: ReadonlyMap<TLShapeId, boolean> }>("Kavla biz mode", {
    enabled: false,
    queryModes: new Map(),
  });
}

function modeFor(editor: Editor) {
  let mode = modes.get(editor);
  if (!mode) {
    mode = createMode();
    modes.set(editor, mode);
  }
  return mode;
}

export function isBizMode(editor: Editor, shapeId?: TLShapeId) {
  const mode = modeFor(editor).get();
  return shapeId ? (mode.queryModes.get(shapeId) ?? mode.enabled) : mode.enabled;
}

function fitQueryToMode(shape: SQLTextAreaShape, enabled: boolean) {
  const size = enabled
    ? getSQLBizSize(shape.props.text, { w: 400, h: 300 }, Boolean(shape.props.error))
    : getAutoExpandedSQLShapeSize(shape.props.text);
  return {
    id: shape.id,
    type: shape.type,
    props: { ...size, isManuallyResized: false },
  };
}

export function setBizMode(editor: Editor, enabled: boolean) {
  editor.complete();
  editor.setEditingShape(null);
  const queries = editor.store
    .allRecords()
    .filter(
      (record): record is SQLTextAreaShape =>
        record.typeName === "shape" && record.type === "sql-text-area" && isBizMode(editor, record.id) !== enabled
    );
  editor.run(() => {
    // A global toggle applies to every query, clearing individual view choices.
    modeFor(editor).set({ enabled, queryModes: new Map() });
    editor.updateShapes(queries.map((shape) => fitQueryToMode(shape, enabled)));
  });
}

export function setQueryBizMode(editor: Editor, shapeId: TLShapeId, enabled: boolean) {
  editor.complete();
  editor.setEditingShape(null);
  const mode = modeFor(editor).get();
  const shape = editor.getShape<SQLTextAreaShape>(shapeId);
  const modeChanged = isBizMode(editor, shapeId) !== enabled;
  const queryModes = new Map(mode.queryModes);
  if (enabled === mode.enabled) queryModes.delete(shapeId);
  else queryModes.set(shapeId, enabled);
  editor.run(() => {
    modeFor(editor).set({ ...mode, queryModes });
    if (shape?.type === "sql-text-area" && modeChanged) {
      editor.updateShapes([fitQueryToMode(shape, enabled)]);
    }
  });
}

export function useBizMode(editor: Editor, shapeId?: TLShapeId) {
  return useValue("Kavla biz mode", () => isBizMode(editor, shapeId), [editor, shapeId]);
}
