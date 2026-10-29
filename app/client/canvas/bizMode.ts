import { atom, useValue, type Editor, type TLShapeId } from "tldraw";
import type { SQLTextAreaShape } from "../../SQLTextArea/sql-text-area-types";
import { getAutoExpandedSQLShapeSize } from "../../SQLTextArea/sqlShapeSize";
import type { DbtMacroShape } from "../../Dbt/dbtTypes";

// A view preference belongs to this editor, never to the saved document.
const modes = new WeakMap<Editor, ReturnType<typeof createMode>>();
type SQLSize = Pick<SQLTextAreaShape["props"], "w" | "h" | "isManuallyResized" | "text">;
const sqlSizes = new WeakMap<Editor, Map<TLShapeId, SQLSize>>();
const macroSizes = new WeakMap<Editor, Map<TLShapeId, Pick<DbtMacroShape["props"], "w" | "h">>>();

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

function fitQueryToMode(editor: Editor, shape: SQLTextAreaShape | DbtMacroShape, enabled: boolean) {
  if (shape.type === "dbt-macro") {
    let sizes = macroSizes.get(editor);
    if (!sizes) {
      sizes = new Map();
      macroSizes.set(editor, sizes);
    }
    const current = { w: shape.props.w, h: shape.props.h };
    const size = enabled ? current : (sizes.get(shape.id) ?? current);
    if (enabled) sizes.set(shape.id, current);
    else sizes.delete(shape.id);
    return { id: shape.id, type: shape.type, props: size };
  }
  let savedSizes = sqlSizes.get(editor);
  if (!savedSizes) {
    savedSizes = new Map();
    sqlSizes.set(editor, savedSizes);
  }
  const saved = savedSizes.get(shape.id);
  const original =
    saved?.text === shape.props.text
      ? saved
      : {
          ...getAutoExpandedSQLShapeSize(shape.props.text),
          isManuallyResized: false,
        };
  if (enabled) {
    savedSizes.set(shape.id, {
      w: shape.props.w,
      h: shape.props.h,
      isManuallyResized: shape.props.isManuallyResized,
      text: shape.props.text,
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
      (record): record is SQLTextAreaShape | DbtMacroShape =>
        record.typeName === "shape" &&
        (record.type === "sql-text-area" || record.type === "dbt-macro") &&
        isBizMode(editor, record.id) !== enabled
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
  const shape = editor.getShape<SQLTextAreaShape | DbtMacroShape>(shapeId);
  const modeChanged = isBizMode(editor, shapeId) !== enabled;
  const queryModes = new Map(mode.queryModes);
  if (enabled === mode.enabled) queryModes.delete(shapeId);
  else queryModes.set(shapeId, enabled);
  editor.run(() => {
    modeFor(editor).set({ ...mode, queryModes });
    if ((shape?.type === "sql-text-area" || shape?.type === "dbt-macro") && modeChanged) {
      editor.updateShapes([fitQueryToMode(editor, shape, enabled)]);
    }
  });
}

export function clearQuerySQLSize(editor: Editor, shapeId: TLShapeId) {
  sqlSizes.get(editor)?.delete(shapeId);
}

export function useBizMode(editor: Editor, shapeId?: TLShapeId) {
  return useValue("Kavla biz mode", () => isBizMode(editor, shapeId), [editor, shapeId]);
}
