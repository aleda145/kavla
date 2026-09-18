import type { Editor, TLShapeId } from "tldraw";
import type { DataSourceShape } from "../DataSource/data-source-types";
import { extractTableNames } from "../util/parseSql.ts";
import type { SQLTextAreaShape } from "./sql-text-area-types";

export type SQLDependencyShape = SQLTextAreaShape | DataSourceShape;

export function getOrderedDependenciesForSQL(
  editor: Editor,
  currentText: string
): {
  orderedDependencies: SQLDependencyShape[];
  immediateUpstreamIds: TLShapeId[];
} {
  const orderedDependencies: SQLDependencyShape[] = [];
  const visited = new Set<TLShapeId>();
  const shapes = editor.getCurrentPageShapes().filter(
    (shape): shape is SQLDependencyShape => shape.type === "sql-text-area" || shape.type === "data-source"
  );
  const resolveInputs = (sql: string): SQLDependencyShape[] => extractTableNames(sql)
    .map((name) => shapes.find((shape) => shape.props.name.toLowerCase() === name.toLowerCase()))
    .filter((shape): shape is SQLDependencyShape => Boolean(shape));

  const getOrderedDeps = (currentShape: SQLDependencyShape) => {
    if (visited.has(currentShape.id)) return;
    visited.add(currentShape.id);

    // Saved arrows can lag behind SQL edits or point to deleted nodes.
    if (currentShape.type === "sql-text-area") {
      for (const upstreamShape of resolveInputs(currentShape.props.text)) {
        getOrderedDeps(upstreamShape);
      }
    }

    orderedDependencies.push(currentShape);
  };

  const immediateUpstreamShapes = resolveInputs(currentText);

  const immediateUpstreamIds = immediateUpstreamShapes.map((shape) => shape.id);
  for (const upstreamShape of immediateUpstreamShapes) {
    getOrderedDeps(upstreamShape);
  }

  return { orderedDependencies, immediateUpstreamIds };
}
