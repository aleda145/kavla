import type { Editor, TLShape, TLShapeId } from "tldraw";
import type { SQLTextAreaShape } from "../SQLTextArea/sql-text-area-types";
import { getOrderedDependenciesForSQL } from "../SQLTextArea/sqlDependencies";

export type ShapeQueryStatus = "orphaned" | "stale" | null;

export function getShapeQueryStatus(editor: Editor, shapeId: TLShapeId): ShapeQueryStatus {
  const shape = editor.getShape(shapeId);
  if (!shape) return null;
  const visited = new Set<string>();
  const isOrphaned = (current: TLShape): boolean => {
    if (visited.has(current.id)) return false;
    visited.add(current.id);
    const inputs =
      current.type === "sql-text-area"
        ? ((current as SQLTextAreaShape).props.upstreamShapeIds ?? [])
        : "sourceShapeId" in current.props && typeof current.props.sourceShapeId === "string"
          ? [current.props.sourceShapeId]
          : [];
    return inputs.some((id) => {
      const input = editor.getShape(id as TLShapeId);
      return !input || isOrphaned(input);
    });
  };
  if (isOrphaned(shape)) return "orphaned";
  const query =
    shape.type === "sql-text-area"
      ? shape
      : "sourceShapeId" in shape.props && typeof shape.props.sourceShapeId === "string"
        ? editor.getShape(shape.props.sourceShapeId as TLShapeId)
        : undefined;
  return query?.type === "sql-text-area" && (query as SQLTextAreaShape).props.stale ? "stale" : null;
}

export function markDownstreamQueriesStale(editor: Editor, sourceId: TLShapeId) {
  const queries = editor
    .getCurrentPageShapes()
    .filter((shape): shape is SQLTextAreaShape => shape.type === "sql-text-area");
  const affected = new Set<string>([sourceId]);
  // Include SQL references as well as saved connections, which can lag behind edits.
  const inputs = new Map(
    queries.map((query) => [
      query.id,
      new Set([
        ...(query.props.upstreamShapeIds ?? []),
        ...getOrderedDependenciesForSQL(editor, query.props.text).immediateUpstreamIds,
      ]),
    ])
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const query of queries) {
      if (affected.has(query.id) || !Array.from(inputs.get(query.id)!).some((id) => affected.has(id))) continue;
      affected.add(query.id);
      changed = true;
    }
  }
  editor.updateShapes<SQLTextAreaShape>(
    queries
      .filter((query) => query.id !== sourceId && affected.has(query.id) && !query.props.stale)
      .map((query) => ({ id: query.id, type: "sql-text-area", props: { stale: true } }))
  );
}
