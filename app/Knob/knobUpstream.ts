import type { Editor, TLShapeId } from "tldraw";
import type { KnobShape } from "./knob-types";
import type { SQLTextAreaShape } from "../SQLTextArea/sql-text-area-types";
import { getOrderedDependenciesForSQL, type SQLDependencyShape } from "../SQLTextArea/sqlDependencies";
import { getKnobNames } from "./knobSQL";

export function isKnobQueryConnected(knob: KnobShape, query: SQLTextAreaShape): boolean {
  return Boolean(
    knob.props.downstreamShapeIds?.includes(query.id) ||
    query.props.upstreamShapeIds?.includes(knob.id) ||
    getKnobNames(query.props.text).includes(knob.props.name.toUpperCase())
  );
}

export function getKnobUpstreamSources(editor: Editor, queries: SQLTextAreaShape[]) {
  const sources: { query: SQLTextAreaShape; source: SQLDependencyShape }[] = [];
  const visited = new Set<string>(queries.map((query) => query.id));
  const inputs = (query: SQLTextAreaShape) => {
    // Keep the last connected inputs while the SQL is being edited or is invalid.
    const saved = (query.props.upstreamShapeIds ?? [])
      .map((id) => editor.getShape(id as TLShapeId))
      .filter((shape): shape is SQLDependencyShape => shape?.type === "sql-text-area" || shape?.type === "data-source");
    if (saved.length) return saved;
    const dependencies = getOrderedDependenciesForSQL(editor, query.props.text);
    return dependencies.orderedDependencies.filter((source) => dependencies.immediateUpstreamIds.includes(source.id));
  };
  const visit = (query: SQLTextAreaShape, source: SQLDependencyShape) => {
    if (visited.has(source.id)) return;
    visited.add(source.id);
    sources.push({ query, source });
    if (source.type === "sql-text-area") for (const input of inputs(source)) visit(query, input);
  };
  for (const query of queries) for (const source of inputs(query)) visit(query, source);
  return sources;
}
