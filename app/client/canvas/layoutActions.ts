import { atom, type Atom, type Editor, type TLUiOverrides } from "tldraw";
import { fitQueryNodes } from "./fitQueryNodes";
import { getLayoutSelection, isLayoutNode } from "./layoutSelection";

const layoutStates = new WeakMap<Editor, Atom<boolean>>();

export function getLayoutInProgress(editor: Editor): Atom<boolean> {
  let state = layoutStates.get(editor);
  if (!state) {
    state = atom("layout in progress", false);
    layoutStates.set(editor, state);
  }
  return state;
}

export function getLayoutActionAvailability(editor: Editor) {
  const enabled = !editor.getIsReadonly() && !getLayoutInProgress(editor).get();
  const selected = enabled ? getLayoutSelection(editor) : [];
  return {
    canLayout: selected.filter(isLayoutNode).length >= 2,
    canFit: selected.some((shape) => shape.type === "sql-text-area"),
  };
}

export const layoutActions: NonNullable<TLUiOverrides["actions"]> = (editor, actions, { addToast }) => {
  const busy = getLayoutInProgress(editor);
  actions["flatten-to-image"] = { ...actions["flatten-to-image"], kbd: "!?f" };
  actions["layout-kavla-nodes"] = {
    id: "layout-kavla-nodes",
    label: "Auto layout",
    kbd: "!a",
    onSelect: async () => {
      if (!getLayoutActionAvailability(editor).canLayout) return;
      const selection = getLayoutSelection(editor).map((shape) => shape.id);
      const pageId = editor.getCurrentPageId();
      busy.set(true);
      try {
        const { layoutKavlaNodes } = await import("./layoutKavlaNodes");
        if (editor.getCurrentPageId() !== pageId) return;
        await layoutKavlaNodes(editor, selection);
      } catch (error) {
        addToast({
          title: "Could not arrange nodes",
          description: error instanceof Error ? error.message : String(error),
          severity: "error",
        });
      } finally {
        busy.set(false);
      }
    },
  };
  actions["fit-query-nodes"] = {
    id: "fit-query-nodes",
    label: "Fit",
    kbd: "!f",
    onSelect: () => {
      if (!getLayoutActionAvailability(editor).canFit) return;
      try {
        fitQueryNodes(editor);
      } catch (error) {
        addToast({
          title: "Could not resize queries",
          description: error instanceof Error ? error.message : String(error),
          severity: "error",
        });
      }
    },
  };
  return actions;
};
