import type { Editor, TLShapeId } from "tldraw";

// Give new nodes a usable starting position even if auto placement stays
// pending or cannot run. This does no collision search or arrow routing.
export function getFallbackNodePosition(
  editor: Editor,
  anchorId: TLShapeId | null,
  side: "right" | "below" | "above" = "right",
  height = 300
) {
  const bounds = anchorId ? editor.getShapePageBounds(anchorId) : undefined;
  const center = editor.getViewportPageBounds().center;
  return {
    parentId: editor.getCurrentPageId(),
    x: bounds ? (side === "right" ? bounds.maxX + 60 : bounds.x) : center.x,
    y: bounds ? (side === "above" ? bounds.y - height - 60 : side === "below" ? bounds.maxY + 60 : bounds.y) : center.y,
  };
}
