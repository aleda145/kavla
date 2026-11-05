import type { Editor, TLShape, TLShapeId } from "tldraw";

// Explicitly opt in: native tldraw shapes and the hidden agent-chat record aren't nodes.
const nodeTypes = new Set([
  "data-source",
  "sql-text-area",
  "sql-result-table",
  "chart-shape",
  "lens-shape",
  "knob",
  "summary-shape",
  "cli-terminal",
  "agent-blob",
]);

export function isLayoutNode(shape: TLShape): boolean {
  return nodeTypes.has(shape.type);
}

export function getLayoutSelection(editor: Editor, ids: TLShapeId[] = editor.getSelectedShapeIds()): TLShape[] {
  // Selecting a container includes its contents, but never expands along links.
  return [...editor.getShapeAndDescendantIds(ids)].flatMap((id) => {
    const shape = editor.getShape(id);
    return shape &&
      editor.getAncestorPageId(shape) === editor.getCurrentPageId() &&
      !editor.isShapeOrAncestorLocked(shape)
      ? [shape]
      : [];
  });
}
