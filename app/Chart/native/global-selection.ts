import type { Editor, TLShapeId } from "tldraw";
import type { ChartShape } from "../chart-shape-types";
import type { ChartSelection } from "./selection";
import type { ChartData } from "./chart-data";
import { selectionRegion, type chartGeometry } from "./geometry.ts";

export function activeAreaChart(editor: Editor) {
  const id = editor.getCurrentPage().meta.selectedAreaChartId;
  return typeof id === "string" ? (id as TLShapeId) : undefined;
}

export function chartAreaValue(editor: Editor, chart: ChartShape) {
  const active = activeAreaChart(editor);
  if (!active) return chart.meta.nativeSelection;
  return chart.id === active ? editor.getCurrentPage().meta.nativeSelection : null;
}

export function areaOnPlot(
  area: ChartSelection,
  chart: ChartShape,
  data: ChartData,
  geometry: ReturnType<typeof chartGeometry>,
  source: { id: TLShapeId; sql: string; revision: string }
): ChartSelection {
  return {
    ...area,
    ...selectionRegion(data, geometry, area.polygon, chart.props.color),
    chartId: chart.id,
    sourceId: source.id,
    sourceRevision: source.revision,
    sourceSQL: source.sql,
  };
}

export function setGlobalArea(editor: Editor, chartId: TLShapeId, area: ChartSelection | null) {
  const page = editor.getCurrentPage();
  editor.updatePage({
    id: page.id,
    meta: { ...page.meta, selectedAreaChartId: chartId, nativeSelection: area && JSON.stringify(area) },
  });
}
