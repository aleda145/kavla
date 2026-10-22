import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { Editor, TLShapeId } from "tldraw";
import { getSelectedAreaReferences } from "./selected-area";
import { navigateToSelectedArea } from "./selected-area-navigation";

export function createSelectedAreaEditorExtensions(editor: Editor, shapeId: TLShapeId) {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = this.build(view);
        }
        update(update: ViewUpdate) {
          if (update.docChanged || update.viewportChanged) this.decorations = this.build(update.view);
        }
        build(view: EditorView) {
          return Decoration.set(
            getSelectedAreaReferences(view.state.doc.toString()).map(({ from, to }) =>
              Decoration.mark({
                class: "cm-selected-area",
                attributes: { title: "Ctrl/Cmd+click to go to selected area" },
              }).range(from, to)
            )
          );
        }
      },
      {
        decorations: (plugin) => plugin.decorations,
        eventHandlers: {
          mousedown(event) {
            if ((!event.ctrlKey && !event.metaKey) || !(event.target as HTMLElement).closest(".cm-selected-area"))
              return false;
            event.preventDefault();
            event.stopPropagation();
            navigateToSelectedArea(editor, shapeId);
            return true;
          },
        },
      }
    ),
    EditorView.baseTheme({
      ".cm-selected-area": {
        backgroundColor: "#27272a",
        color: "#fafafa !important",
        borderBottom: "2px solid #09090b",
        borderRadius: "3px",
      },
      ".cm-selected-area *": { color: "inherit !important", backgroundColor: "transparent", borderBottom: "none" },
      ".cm-selected-area:hover": { cursor: "pointer" },
    }),
  ];
}
