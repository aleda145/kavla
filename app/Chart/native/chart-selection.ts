import type { Editor, TLShapeId } from "tldraw";
import type { ChartShape } from "../chart-shape-types";
import { readSelections, serializeSelections, type ChartSelection } from "./selection.ts";
import type { ChartData } from "./chart-data";
import { selectionRegion, type chartGeometry } from "./geometry.ts";

export function chartAreaValue(editor: Editor, chart: ChartShape) {
  // Older files stored one collection on the page, including an explicit empty selection.
  const page = editor.getCurrentPage();
  if (page.meta.selectedAreaChartId === chart.id) return page.meta.nativeSelection;
  return editor.getShape<ChartShape>(chart.id)?.meta.nativeSelection;
}

export function readChartSelections(value: unknown, chartId: TLShapeId) {
  // Duplicating or pasting a chart may copy metadata containing the original chart's ID.
  return readSelections(value).filter((region) => region.chartId === chartId);
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
    ...selectionRegion(data, geometry, area.polygon, chart.props.color, area.inverted),
    sourceId: source.id,
    sourceRevision: source.revision,
    sourceSQL: source.sql,
  };
}

export function setChartArea(editor: Editor, chartId: TLShapeId, regions: ChartSelection[]) {
  const page = editor.getCurrentPage();
  editor.run(() => {
    editor.updateShape<ChartShape>({
      id: chartId,
      type: "chart-shape",
      meta: { nativeSelection: serializeSelections(regions) },
    });
    if (page.meta.selectedAreaChartId === chartId) {
      editor.updatePage({ id: page.id, meta: { ...page.meta, selectedAreaChartId: null, nativeSelection: null } });
    }
  });
}
