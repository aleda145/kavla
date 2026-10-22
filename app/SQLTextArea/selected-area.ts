import type { Editor, TLShapeId } from "tldraw";
import { tokenizeSQL } from "../Knob/knobSQL";
import { identifier, readSelection, selectionSQL } from "../Chart/native/selection";
import { stripTrailingSemicolons } from "../src/duckdb/sql";
import type { SQLTextAreaShape } from "./sql-text-area-types";

export function getSelectedAreaReferences(sql: string) {
  const tokens = tokenizeSQL(sql).filter((token) => token.kind !== "ignored");
  return tokens.filter((token, index) => {
    const name = token.kind === "identifier" ? token.text.slice(1, -1) : token.text;
    return (
      (token.kind === "code" || token.kind === "identifier") &&
      name.toLowerCase() === "selected_area" &&
      tokens[index - 1]?.text !== "."
    );
  });
}

export function hasSelectedAreaBinding(shape: SQLTextAreaShape | undefined): boolean {
  return typeof shape?.meta.nativeSelection === "string";
}

export function getSelectedAreaSource(editor: Editor, sql: string, shape?: SQLTextAreaShape) {
  if (!hasSelectedAreaBinding(shape) || !getSelectedAreaReferences(sql).length) return null;
  const selection = readSelection(shape!.meta.nativeSelection);
  if (!selection) throw new Error("The selected area definition is missing. Explore the chart area again.");
  const source = editor.getShape<SQLTextAreaShape>(selection.sourceId as TLShapeId);
  return { selection, source: source?.type === "sql-text-area" ? source : undefined };
}

// Each query owns its binding: two branches can both use selected_area without
// sharing a polygon. Downstream queries expand each dependency in its own scope.
export function resolveSelectedAreaSQL(editor: Editor, sql: string, shapeId?: TLShapeId): string {
  const shape = shapeId ? editor.getShape<SQLTextAreaShape>(shapeId) : undefined;
  const area = getSelectedAreaSource(editor, sql, shape);
  if (!area) return sql;
  if (!area.source) throw new Error("The source query for selected_area no longer exists.");
  const limit = shape?.meta.selectedAreaLimit;
  if (limit != null && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1))
    throw new Error("The saved selected area row limit is invalid.");
  const input = `SELECT * FROM ${identifier(area.source.props.name)}${limit == null ? "" : ` LIMIT ${limit}`}`;
  return `WITH selected_area AS (${selectionSQL(input, area.selection)})\nSELECT * FROM (${stripTrailingSemicolons(sql)}) AS kavla_area_query`;
}
