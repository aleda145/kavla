import type { Editor, TLAssetId, TLShape, TLShapeId } from "tldraw";
import { DuckDBService } from "@/duckdb-service";
import { removeShapeFromConnections } from "../../util/shapeConnections";
import type { DataSourceShape } from "../../DataSource/data-source-types";
import type { SQLTextAreaShape } from "../../SQLTextArea/sql-text-area-types";
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
    deletedShape.type === "sql-result-table"
  ) {
    removeShapeFromConnections(editor, deletedShape.id);
  }

  if (deletedShape.type === "data-source") {
    deleteShapes([deletedShape.id]);
    const { name } = (deletedShape as DataSourceShape).props;
    const duckDB = DuckDBService.getInstance();
    void duckDB.releaseTable(name).catch((error) => console.error("Could not clean up deleted data source", error));
    return;
  }

  if (deletedShape.type === "sql-text-area") {
    deleteShapes([deletedShape.id]);
    const queryShape = deletedShape as SQLTextAreaShape;
    const duckDB = DuckDBService.getInstance();
    void duckDB
      .releaseTable(queryShape.props.name)
      .catch((error) => console.error("Could not clean up deleted query", error));
  }
}
