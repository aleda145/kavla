import { atom, useValue, type Editor } from "tldraw";

// A view preference belongs to this editor, never to the saved document.
const modes = new WeakMap<Editor, ReturnType<typeof createMode>>();

function createMode() {
  return atom("Kavla biz mode", false);
}

function modeFor(editor: Editor) {
  let mode = modes.get(editor);
  if (!mode) {
    mode = createMode();
    modes.set(editor, mode);
  }
  return mode;
}

export function isBizMode(editor: Editor) {
  return modeFor(editor).get();
}

export function setBizMode(editor: Editor, enabled: boolean) {
  editor.complete();
  editor.setEditingShape(null);
  modeFor(editor).set(enabled);
}

export function useBizMode(editor: Editor) {
  return useValue("Kavla biz mode", () => isBizMode(editor), [editor]);
}
