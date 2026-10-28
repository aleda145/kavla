import { getCompiledDbtModels } from "../Dbt/dbtCompilation";
import { resolveDbtReferences } from "../Dbt/dbtSQL";
import type { Editor, TLShapeId } from "tldraw";
import type { DataSourceShape } from "../DataSource/data-source-types";
import { extractTableNames } from "../util/parseSql.ts";
import type { SQLTextAreaShape } from "./sql-text-area-types";

export type SQLDependencyShape = SQLTextAreaShape | DataSourceShape;

export function getOrderedDependenciesForSQL(
  editor: Editor,
  currentText: string,
  compiled: Record<string, string> = getCompiledDbtModels(editor)
): {
  orderedDependencies: SQLDependencyShape[];
  immediateUpstreamIds: TLShapeId[];
  cycle?: string;
} {
  const orderedDependencies: SQLDependencyShape[] = [];
  const visiting = new Set<TLShapeId>();
  let cycle: string | undefined;
  const visited = new Set<TLShapeId>();
  const shapes = editor
    .getCurrentPageShapes()
    .filter((shape): shape is SQLDependencyShape => shape.type === "sql-text-area" || shape.type === "data-source");
  const resolveInputs = (sql: string): SQLDependencyShape[] =>
    extractTableNames(resolveDbtReferences(editor, sql))
      .map((name) => shapes.find((shape) => shape.props.name.toLowerCase() === name.toLowerCase()))
      .filter((shape): shape is SQLDependencyShape => Boolean(shape));

  const getOrderedDeps = (currentShape: SQLDependencyShape) => {
    if (visiting.has(currentShape.id)) {
      cycle = `Circular query dependency at ${currentShape.props.name}.`;
      return;
    }
    if (visited.has(currentShape.id)) return;
    visiting.add(currentShape.id);

    // Saved arrows can lag behind SQL edits or point to deleted nodes.
    if (currentShape.type === "sql-text-area") {
      for (const upstreamShape of resolveInputs(compiled[currentShape.id] ?? currentShape.props.text)) {
        getOrderedDeps(upstreamShape);
      }
    }

    visiting.delete(currentShape.id);
    visited.add(currentShape.id);
    orderedDependencies.push(currentShape);
  };

  const currentModel = shapes.find(
    (shape) => shape.type === "sql-text-area" && shape.props.text === currentText && compiled[shape.id] !== undefined
  );
  const immediateUpstreamShapes = resolveInputs(currentModel ? compiled[currentModel.id] : currentText);

  const immediateUpstreamIds = immediateUpstreamShapes.map((shape) => shape.id);
  for (const upstreamShape of immediateUpstreamShapes) {
    getOrderedDeps(upstreamShape);
  }

  return { orderedDependencies, immediateUpstreamIds, cycle };
}
