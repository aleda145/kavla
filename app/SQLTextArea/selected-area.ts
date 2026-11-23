import type { Editor, TLShapeId } from "tldraw";
import { tokenizeSQL } from "../Knob/knobSQL";
import { identifier, readSelection, selectionSQL, type ChartSelection } from "../Chart/native/selection";
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

// While finding related shapes, leave an unreadable selection to report its error on its own chart or query.
function findBinding(value: unknown) {
  try {
    return readSelection(value);
  } catch {
    return null;
  }
}

export function queriesForSelectedArea(editor: Editor, chartId: TLShapeId, selection: ChartSelection) {
  return editor.getCurrentPageShapes().filter((shape): shape is SQLTextAreaShape => {
    if (shape.type !== "sql-text-area") return false;
    const binding = findBinding(shape.meta.nativeSelection);
    return (
      binding?.chartId === chartId &&
      binding.drawingId === selection.drawingId &&
      binding.sourceId === selection.sourceId
    );
  });
}

export function syncMovedSelectedAreas(editor: Editor) {
  // Documents saved before moves updated their queries may already have a newer position on the chart.
  const derived = { history: "ignore", ignoreShapeLock: true } as const;
  editor.run(() => {
    for (const query of editor.getCurrentPageShapes()) {
      if (query.type !== "sql-text-area") continue;
      const binding = findBinding(query.meta.nativeSelection);
      if (!binding) continue;
      const chart = editor.getShape(binding.chartId as TLShapeId);
      if (chart?.type !== "chart-shape" || chart.meta.nativeSelection === query.meta.nativeSelection) continue;
      const current = findBinding(chart.meta.nativeSelection);
      if (
        current?.chartId === chart.id &&
        current.drawingId === binding.drawingId &&
        current.sourceId === binding.sourceId
      ) {
        editor.updateShape({
          id: query.id,
          type: query.type,
          meta: { ...query.meta, nativeSelection: chart.meta.nativeSelection },
        });
      }
    }
  }, derived);
  return editor.sideEffects.registerAfterChangeHandler("shape", (before, after) => {
    if (after.type !== "chart-shape" || before.meta.nativeSelection === after.meta.nativeSelection) return;
    const previous = findBinding(before.meta.nativeSelection);
    const moved = findBinding(after.meta.nativeSelection);
    if (!previous || !moved || previous.drawingId !== moved.drawingId || previous.sourceId !== moved.sourceId) return;
    // Undo/redo moves the chart outline. Keep the derived binding out of history so undoing a move
    // cannot restore obsolete SQL execution state (for example, a run that has since finished).
    const nativeSelection =
      moved.chartId === after.id ? after.meta.nativeSelection : JSON.stringify({ ...moved, chartId: after.id });
    editor.run(() => {
      for (const query of queriesForSelectedArea(editor, after.id, moved)) {
        editor.updateShape<SQLTextAreaShape>({
          id: query.id,
          type: "sql-text-area",
          meta: { ...query.meta, nativeSelection },
        });
      }
    }, derived);
  });
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
