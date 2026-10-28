import type { Editor, TLUiOverrides } from "tldraw";
import { isBizMode, setBizMode } from "./canvas/bizMode";
import { toggleJustIcons } from "./justIcons";

export function applyCanvasPreferences(editor: Editor) {
  editor.user.updateUserPreferences({
    isSnapMode: true,
    edgeScrollSpeed: 1,
    isPasteAtCursorMode: true,
    isWrapMode: false,
    isDynamicSizeMode: false,
  });
  editor.updateInstanceState({
    isToolLocked: false,
    isGridMode: false,
    isFocusMode: false,
  });
}

export const canvasPreferenceActions: NonNullable<TLUiOverrides["actions"]> = (editor, actions) => {
  for (const id of [
    "toggle-snap-mode",
    "toggle-edge-scrolling",
    "toggle-paste-at-cursor",
    "toggle-wrap-mode",
    "toggle-dynamic-size-mode",
    "toggle-tool-lock",
    "toggle-grid",
    "toggle-focus-mode",
  ]) {
    delete actions[id];
  }
  actions["toggle-biz-mode"] = {
    id: "toggle-biz-mode",
    label: "Toggle SQL/Biz mode",
    icon: "sql",
    kbd: "!b",
    readonlyOk: true,
    onSelect: () => setBizMode(editor, !isBizMode(editor)),
  };
  actions["toggle-just-icons"] = {
    id: "toggle-just-icons",
    label: "Just icons",
    kbd: "!c",
    readonlyOk: true,
    onSelect: toggleJustIcons,
  };
  return actions;
};
