import { getDbtRelationReferences } from "./dbtSQL";
import { dbtColors } from "./dbtColors";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { Editor, TLShapeId } from "tldraw";
import { getDbtMacroReferences, navigateToDbtShape } from "./dbtMacros";

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
            [
              ...getDbtMacroReferences(editor, view.state.doc.toString()).map((reference) =>
                Decoration.mark({
                  class: "cm-dbt-macro-reference",
                  attributes: {
                    "data-dbt-shape": reference.shapeId,
                    title: `${reference.path} · Ctrl/Cmd+click to go to macro`,
                  },
                }).range(reference.from, reference.to)
              ),
              ...getDbtRelationReferences(editor, view.state.doc.toString()).map((reference) =>
                Decoration.mark({
                  class: reference.shapeType === "sql-text-area" ? "cm-spatial-link-query" : "cm-spatial-link",
                  attributes: {
                    "data-dbt-shape": reference.shapeId,
                    title: `${reference.label} · Ctrl/Cmd+click to go to node`,
                  },
                }).range(reference.from, reference.to)
              ),
            ],
            true
          );
        }
      },
      {
        decorations: (plugin) => plugin.decorations,
        eventHandlers: {
          mousedown(event) {
            if (!event.ctrlKey && !event.metaKey) return false;
            const element = (event.target as HTMLElement).closest<HTMLElement>("[data-dbt-shape]");
            if (!element?.dataset.dbtShape) return false;
            event.preventDefault();
            event.stopPropagation();
            navigateToDbtShape(editor, element.dataset.dbtShape as TLShapeId);
            return true;
          },
        },
      }
    ),
    EditorView.theme({
      ".cm-dbt-macro-reference": {
        backgroundColor: dbtColors.surface,
        color: `${dbtColors.text} !important`,
        borderBottom: `2px solid ${dbtColors.accent}`,
        fontWeight: "700",
      },
      ".cm-dbt-macro-reference *": { color: `${dbtColors.text} !important` },
    }),
  ];
}
