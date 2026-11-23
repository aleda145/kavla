import type { Editor, TLShapeId } from "tldraw";
import { tokenizeSQL } from "../Knob/knobSQL";
import { identifier, readSelection, selectionSQL } from "../Chart/native/selection";
import { stripTrailingSemicolons } from "../src/duckdb/sql";
import type { ChartShape } from "../Chart/chart-shape-types";
import { extractTableNames } from "../util/parseSql";
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

export function selectedAreaChartId(query?: SQLTextAreaShape): TLShapeId | undefined {
  if (typeof query?.meta.selectedAreaChartId === "string") return query.meta.selectedAreaChartId as TLShapeId;
  // Earlier files embedded a copy of the polygon in the query. Its chart ID is the durable link.
  if (typeof query?.meta.nativeSelection !== "string") return undefined;
  try {
    return readSelection(query.meta.nativeSelection)?.chartId as TLShapeId | undefined;
  } catch {
    return undefined;
  }
}

export function queriesForSelectedArea(editor: Editor, chartId: TLShapeId) {
  return editor
    .getCurrentPageShapes()
    .filter(
      (shape): shape is SQLTextAreaShape =>
        shape.type === "sql-text-area" && selectedAreaChartId(shape as SQLTextAreaShape) === chartId
    );
}

export function getSelectedAreaSource(editor: Editor, sql: string, query?: SQLTextAreaShape) {
  if (!query || !/\bselected_area\b/i.test(sql) || !getSelectedAreaReferences(sql).length) return null;
  let chartId = selectedAreaChartId(query);
  if (!chartId) {
    // A standalone query can use the sole chart. Preserve explicitly named tables and local CTEs.
    const shapes = editor.getCurrentPageShapes();
    if (!extractTableNames(sql).some((name) => name.toLowerCase() === "selected_area")) return null;
    const namedTable = shapes.some(
      (shape) =>
        (shape.type === "sql-text-area" || shape.type === "data-source") &&
        "name" in shape.props &&
        typeof shape.props.name === "string" &&
        shape.props.name.toLowerCase() === "selected_area"
    );
    if (namedTable) return null;
    const tokens = tokenizeSQL(sql).filter((token) => token.kind !== "ignored");
    if (
      tokens.some(
        (token, i) =>
          token.text.replace(/^"|"$/g, "").toLowerCase() === "selected_area" &&
          tokens[i + 1]?.text.toLowerCase() === "as" &&
          tokens[i + 2]?.text === "("
      )
    )
      return null;
    const charts = shapes.filter((shape): shape is ChartShape => shape.type === "chart-shape");
    const connected = charts.filter((chart) => query.props.upstreamShapeIds?.includes(chart.id));
    const candidates = connected.length ? connected : charts;
    if (!candidates.length) return null;
    if (candidates.length === 1) chartId = candidates[0].id;
  }
  const chart = chartId ? editor.getShape<ChartShape>(chartId) : undefined;
  const source =
    chart?.type === "chart-shape" && chart.props.sourceShapeId
      ? editor.getShape<SQLTextAreaShape>(chart.props.sourceShapeId as TLShapeId)
      : undefined;
  return {
    chartId,
    chart: chart?.type === "chart-shape" ? chart : undefined,
    source: source?.type === "sql-text-area" ? source : undefined,
  };
}

export function hasSelectedAreaBinding(editor: Editor, query?: SQLTextAreaShape) {
  return Boolean(
    selectedAreaChartId(query) || (query && getSelectedAreaSource(editor, query.props.text, query)?.chart)
  );
}

export function resolveSelectedAreaSQL(editor: Editor, sql: string, shapeId?: TLShapeId): string {
  const shape = shapeId ? editor.getShape<SQLTextAreaShape>(shapeId) : undefined;
  const area = getSelectedAreaSource(editor, sql, shape);
  if (!area) return sql;
  if (!area.chartId) throw new Error("Choose a source chart for selected_area in this query.");
  if (!area.chart) throw new Error("The chart for selected_area no longer exists.");
  if (!area.source) throw new Error("Connect the selected_area chart to a source query.");
  const selection = readSelection(area.chart.meta.nativeSelection);
  const limit = area.chart.props.limit;
  const input = `SELECT * FROM ${identifier(area.source.props.name)}${limit == null ? "" : ` LIMIT ${Math.max(1, Math.floor(limit))}`}`;
  const rows =
    selection && selection.sourceId === area.source.id
      ? selectionSQL(input, selection)
      : `SELECT * FROM (${input}) AS chart_input WHERE FALSE`;
  return `WITH selected_area AS (${rows})\nSELECT * FROM (${stripTrailingSemicolons(sql)}) AS kavla_area_query`;
}
