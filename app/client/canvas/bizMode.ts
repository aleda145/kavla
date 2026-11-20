import { atom, useValue, type Editor, type TLShapeId } from "tldraw";
import { getLayoutSelection } from "./layoutSelection";

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

export function setBizMode(editor: Editor, enabled: boolean) {
  editor.complete();
  editor.setEditingShape(null);
  // A global toggle applies to every query, clearing individual view choices.
  // Both views fit or scroll inside the current shape dimensions.
  modeFor(editor).set({ enabled, queryModes: new Map() });
}

export function getSelectedQueryIds(editor: Editor): TLShapeId[] {
  return getLayoutSelection(editor)
    .filter((shape) => shape.type === "sql-text-area")
    .map((shape) => shape.id);
}

export function setQueryBizMode(editor: Editor, shapeId: TLShapeId, enabled: boolean) {
  setQueriesBizMode(editor, [shapeId], enabled);
}

export function setQueriesBizMode(editor: Editor, shapeIds: TLShapeId[], enabled: boolean) {
  if (!shapeIds.length) return;
  editor.complete();
  editor.setEditingShape(null);
  const mode = modeFor(editor).get();
  const queryModes = new Map(mode.queryModes);
  for (const shapeId of shapeIds) {
    if (enabled === mode.enabled) queryModes.delete(shapeId);
    else queryModes.set(shapeId, enabled);
  }
  modeFor(editor).set({ ...mode, queryModes });
}

export function useBizMode(editor: Editor, shapeId?: TLShapeId) {
  return useValue("Kavla biz mode", () => isBizMode(editor, shapeId), [editor, shapeId]);
}
