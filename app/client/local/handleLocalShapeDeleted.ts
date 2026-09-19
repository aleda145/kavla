import type { Editor, TLAssetId, TLShape, TLShapeId } from "tldraw";
import { removeShapeFromConnections } from "../../util/shapeConnections";
import { localAssetStore } from "./localAssetStore";

export function handleLocalShapeDeleted(
  editor: Editor,
  deletedShape: TLShape,
  deleteShapes: (shapeIds: TLShapeId[]) => void
): void {
  if (deletedShape.type === "image" || deletedShape.type === "video") {
    const assetId = "assetId" in deletedShape.props ? deletedShape.props.assetId : null;
    if (assetId) {
      void Promise.resolve(localAssetStore.remove?.([assetId as TLAssetId])).catch((error) =>
        console.error("Could not clean up deleted canvas asset", error)
      );
    }
  }

  if (
    deletedShape.type === "sql-text-area" ||
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
