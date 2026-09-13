import type { Editor, TLShapeId } from "tldraw";
import type { DataSourceShape } from "../DataSource/data-source-types";
import { extractTableNames } from "../util/parseSql";
import type { ComputeShape } from "../Python/types";

export type SQLDependencyShape = ComputeShape | DataSourceShape;

export function getOrderedDependenciesForSQL(
  editor: Editor,
  currentText: string
): {
  orderedDependencies: SQLDependencyShape[];
  immediateUpstreamIds: TLShapeId[];
} {
  const orderedDependencies: SQLDependencyShape[] = [];
  const visited = new Set<TLShapeId>();

  const getOrderedDeps = (shapeId: TLShapeId) => {
    if (visited.has(shapeId)) return;
    visited.add(shapeId);

    const currentShape = editor.getShape(shapeId);
    if (!currentShape || (currentShape.type !== "sql-text-area" && currentShape.type !== "python-text-area" && currentShape.type !== "data-source")) {
      return;
    }

    const upstreamIds = currentShape.type === "sql-text-area"
      ? extractTableNames((currentShape as ComputeShape).props.text).flatMap(name => editor.getCurrentPageShapes().filter(shape =>
        (shape.type === "sql-text-area" || shape.type === "python-text-area" || shape.type === "data-source") &&
        (shape as SQLDependencyShape).props.name.toLowerCase() === name.toLowerCase()).map(shape => shape.id))
      : (currentShape.props as { upstreamShapeIds?: string[] | null }).upstreamShapeIds ?? [];
    for (const upstreamId of upstreamIds) {
      getOrderedDeps(upstreamId as TLShapeId);
    }

    orderedDependencies.push(currentShape as SQLDependencyShape);
  };

  const immediateUpstreamShapes = extractTableNames(currentText)
    .map((name) =>
      editor
        .getCurrentPageShapes()
        .find(
          (shape) =>
            (shape.type === "data-source" || shape.type === "sql-text-area" || shape.type === "python-text-area") &&
            (shape as SQLDependencyShape).props.name.toLowerCase() === name.toLowerCase()
        )
    )
    .filter((shape): shape is SQLDependencyShape => Boolean(shape));

  const immediateUpstreamIds = immediateUpstreamShapes.map((shape) => shape.id);
  for (const upstreamId of immediateUpstreamIds) {
    getOrderedDeps(upstreamId);
  }

  return { orderedDependencies, immediateUpstreamIds };
}
