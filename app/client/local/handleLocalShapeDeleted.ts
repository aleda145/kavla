import type { Editor, TLShape, TLShapeId } from "tldraw";
import { removeShapeFromConnections } from "../../util/shapeConnections";

export function handleLocalShapeDeleted(
  editor: Editor,
  deletedShape: TLShape,
  deleteShapes: (shapeIds: TLShapeId[]) => void
): void {
  if (
    deletedShape.type === "sql-text-area" ||
    deletedShape.type === "knob" ||
    deletedShape.type === "data-source" ||
    deletedShape.type === "chart-shape" ||
    deletedShape.type === "lens-shape" ||
    deletedShape.type === "sql-result-table"
  ) {
    removeShapeFromConnections(editor, deletedShape.id);
  }

  if (deletedShape.type === "sql-text-area") {
    deleteShapes([deletedShape.id]);
  }
}
