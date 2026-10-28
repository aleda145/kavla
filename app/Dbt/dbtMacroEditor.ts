import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { Editor, TLShapeId } from "tldraw";
import { getDbtMacroReferences, navigateToDbtMacro } from "./dbtMacros";

export function createDbtMacroEditorExtensions(editor: Editor) {
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
            getDbtMacroReferences(editor, view.state.doc.toString()).map((reference) =>
              Decoration.mark({
                class: "cm-dbt-macro-reference",
                attributes: {
                  "data-macro-shape": reference.shapeId,
                  title: `${reference.path} · Ctrl/Cmd+click to go to macro`,
                },
              }).range(reference.from, reference.to)
            ),
            true
          );
        }
      },
      {
        decorations: (plugin) => plugin.decorations,
        eventHandlers: {
          mousedown(event) {
            if (!event.ctrlKey && !event.metaKey) return false;
            const element = (event.target as HTMLElement).closest<HTMLElement>("[data-macro-shape]");
            if (!element?.dataset.macroShape) return false;
            event.preventDefault();
            event.stopPropagation();
            navigateToDbtMacro(editor, element.dataset.macroShape as TLShapeId);
            return true;
          },
        },
      }
    ),
    EditorView.theme({
      ".cm-dbt-macro-reference": {
        backgroundColor: "#ffedd5",
        color: "#9a3412 !important",
        borderBottom: "2px solid #f97316",
        fontWeight: "700",
      },
      ".cm-dbt-macro-reference *": { color: "#9a3412 !important" },
    }),
  ];
}
