import type { Editor, TLShapeId } from "tldraw";
import { tokenizeSQL } from "../Knob/knobSQL";
import { clusteredRowsSQL, identifier, readSelection, selectionSQL } from "../Chart/native/selection";
import { stripTrailingSemicolons } from "../src/duckdb/sql";
import type { ChartShape } from "../Chart/chart-shape-types";
import { chartAreaValue, readChartSelections } from "../Chart/native/chart-selection";
import { extractTableNames } from "../util/parseSql";
import type { SQLTextAreaShape } from "./sql-text-area-types";

export type ChartRowsRelation = "selected_area" | "clustered_rows";

export function isChartRowsRelation(name: string): name is ChartRowsRelation {
  return name === "selected_area" || name === "clustered_rows";
}

export function getSelectedAreaReferences(sql: string) {
  const tokens = tokenizeSQL(sql).filter((token) => token.kind !== "ignored");
  return tokens.filter((token, index) => {
    const name = token.kind === "identifier" ? token.text.slice(1, -1) : token.text;
    return (
      (token.kind === "code" || token.kind === "identifier") &&
      isChartRowsRelation(name.toLowerCase()) &&
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
  return editor.getCurrentPageShapes().filter((shape): shape is SQLTextAreaShape => {
    if (shape.type !== "sql-text-area") return false;
    const bound = selectedAreaChartId(shape as SQLTextAreaShape);
    return bound === chartId;
  });
}

export function getSelectedAreaSource(editor: Editor, sql: string, query?: SQLTextAreaShape) {
  if (!query || !/\b(?:selected_area|clustered_rows)\b/i.test(sql)) return null;
  let chartId = selectedAreaChartId(query);
  const shapes = editor.getCurrentPageShapes();
  // Bound queries can reference either relation anywhere DuckDB accepts a table,
  // including TABLE name and comma joins. Handwritten queries must first name it as an input.
  const names = chartId
    ? getSelectedAreaReferences(sql).map((token) => token.text.replace(/^"|"$/g, "").toLowerCase())
    : extractTableNames(sql).map((name) => name.toLowerCase());
  const tokens = tokenizeSQL(sql).filter((token) => token.kind !== "ignored");
  const relations = [...new Set(names.filter(isChartRowsRelation))].filter((name) => {
    if (
      tokens.some(
        (token, i) =>
          token.text.replace(/^"|"$/g, "").toLowerCase() === name &&
          tokens[i + 1]?.text.toLowerCase() === "as" &&
          tokens[i + 2]?.text === "("
      )
    )
      return false;
    if (chartId) return true;
    return !shapes.some(
      (shape) =>
        (shape.type === "sql-text-area" || shape.type === "data-source") &&
        "name" in shape.props &&
        typeof shape.props.name === "string" &&
        shape.props.name.toLowerCase() === name
    );
  });
  if (!relations.length) return null;
  if (!chartId) {
    const charts = shapes.filter((shape): shape is ChartShape => shape.type === "chart-shape");
    const connected = charts.filter((chart) => query.props.upstreamShapeIds?.includes(chart.id));
    const candidates = connected.length ? connected : charts;
    if (candidates.length === 1) chartId = candidates[0].id;
    else if (!candidates.length) return null;
  }
  const chart = chartId ? editor.getShape<ChartShape>(chartId) : undefined;
  const source =
    chart?.type === "chart-shape" && chart.props.sourceShapeId
      ? editor.getShape<SQLTextAreaShape>(chart.props.sourceShapeId as TLShapeId)
      : undefined;
  return {
    relations,
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
  const relation = area.relations.join(" and ");
  if (!area.chartId) throw new Error(`Choose a source chart for ${relation} in this query.`);
  if (!area.chart) throw new Error(`The chart for ${relation} no longer exists.`);
  if (!area.source) throw new Error(`Connect the chart for ${relation} to a source query.`);
  const sourceId = area.source.id;
  const regions = readChartSelections(chartAreaValue(editor, area.chart), area.chart.id).filter(
    (r) => r.sourceId === sourceId
  );
  const limit = area.chart.props.limit;
  const input = `SELECT * FROM ${identifier(area.source.props.name)}${limit == null ? "" : ` LIMIT ${Math.max(1, Math.floor(limit))}`}`;
  const tables = area.relations.map((name) => {
    const rows = name === "clustered_rows" ? clusteredRowsSQL(input, regions) : selectionSQL(input, regions);
    return `${name} AS (${rows})`;
  });
  return `WITH ${tables.join(",\n")}\nSELECT * FROM (${stripTrailingSemicolons(sql)}) AS kavla_area_query`;
}
