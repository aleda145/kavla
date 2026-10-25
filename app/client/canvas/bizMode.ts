import { atom, useValue, type Editor, type TLShapeId } from "tldraw";
import type { SQLTextAreaShape } from "../../SQLTextArea/sql-text-area-types";

// A view preference belongs to this editor, never to the saved document.
const modes = new WeakMap<Editor, ReturnType<typeof createMode>>();
type SQLSize = Pick<SQLTextAreaShape["props"], "w" | "h" | "isManuallyResized">;
const sqlSizes = new WeakMap<Editor, Map<TLShapeId, SQLSize>>();

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

function fitQueryToMode(editor: Editor, shape: SQLTextAreaShape, enabled: boolean) {
  let savedSizes = sqlSizes.get(editor);
  if (!savedSizes) {
    savedSizes = new Map();
    sqlSizes.set(editor, savedSizes);
  }
  const original = savedSizes.get(shape.id) ?? shape.props;
  if (enabled) {
    savedSizes.set(shape.id, {
      w: shape.props.w,
      h: shape.props.h,
      isManuallyResized: shape.props.isManuallyResized,
    });
  } else {
    savedSizes.delete(shape.id);
  }
  // Keep the SQL dimensions unchanged; the pipeline fits or scrolls inside them.
  // Restore that target on return, even if the Biz view was manually resized.
  const size = enabled ? { w: shape.props.w, h: shape.props.h } : { w: original.w, h: original.h };
  return {
    id: shape.id,
    type: shape.type,
    props: {
      ...size,
      isManuallyResized: (enabled ? shape.props.isManuallyResized : original.isManuallyResized) ?? false,
    },
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
    editor.updateShapes(queries.map((shape) => fitQueryToMode(editor, shape, enabled)));
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
      editor.updateShapes([fitQueryToMode(editor, shape, enabled)]);
    }
  });
}

export function useBizMode(editor: Editor, shapeId?: TLShapeId) {
  return useValue("Kavla biz mode", () => isBizMode(editor, shapeId), [editor, shapeId]);
}
