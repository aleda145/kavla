import type { Editor, TLShapeId } from "tldraw";
import type { DataSourceShape } from "../DataSource/data-source-types";
import { extractTableNames } from "../util/parseSql.ts";
import type { SQLTextAreaShape } from "./sql-text-area-types";
import { getSelectedAreaSource } from "./selected-area";

export type SQLDependencyShape = SQLTextAreaShape | DataSourceShape;

export function getOrderedDependenciesForSQL(
  editor: Editor,
  currentText: string,
  shapeId?: TLShapeId
): {
  orderedDependencies: SQLDependencyShape[];
  immediateUpstreamIds: TLShapeId[];
  immediateSQLInputs: SQLDependencyShape[];
} {
  const orderedDependencies: SQLDependencyShape[] = [];
  const visited = new Set<TLShapeId>();
  const shapes = editor
    .getCurrentPageShapes()
    .filter((shape): shape is SQLDependencyShape => shape.type === "sql-text-area" || shape.type === "data-source");
  const resolveInputs = (sql: string, context?: SQLTextAreaShape) => {
    const area = getSelectedAreaSource(editor, sql, context);
    const inputs = extractTableNames(sql)
      .filter((name) => !area || name.toLowerCase() !== "selected_area")
      .map((name) => shapes.find((shape) => shape.props.name.toLowerCase() === name.toLowerCase()))
      .filter((shape): shape is SQLDependencyShape => Boolean(shape));
    const canvasIds = inputs.map((shape) => shape.id);
    if (area?.chart) canvasIds.push(area.chart.id);
    // DuckDB expands the query feeding the chart. The canvas edge goes through the chart itself.
    if (area?.source && !inputs.some((shape) => shape.id === area.source!.id)) inputs.push(area.source);
    return { inputs, canvasIds };
  };

  const getOrderedDeps = (currentShape: SQLDependencyShape) => {
    if (visited.has(currentShape.id)) return;
    visited.add(currentShape.id);

    // Saved arrows can lag behind SQL edits or point to deleted nodes.
    if (currentShape.type === "sql-text-area") {
      for (const upstreamShape of resolveInputs(currentShape.props.text, currentShape).inputs) {
        getOrderedDeps(upstreamShape);
      }
    }

    orderedDependencies.push(currentShape);
  };

  const { inputs: immediateSQLInputs, canvasIds: immediateUpstreamIds } = resolveInputs(
    currentText,
    shapeId ? editor.getShape<SQLTextAreaShape>(shapeId) : undefined
  );

  for (const upstreamShape of immediateSQLInputs) {
    getOrderedDeps(upstreamShape);
  }

  return { orderedDependencies, immediateUpstreamIds, immediateSQLInputs };
}
