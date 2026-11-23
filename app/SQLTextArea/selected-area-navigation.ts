import type { Editor, TLShapeId } from "tldraw";
import type { SQLTextAreaShape } from "./sql-text-area-types";
import { getSelectedAreaSource } from "./selected-area";

export function navigateToSelectedArea(editor: Editor, queryId: TLShapeId) {
  const query = editor.getShape<SQLTextAreaShape>(queryId);
  if (query?.type !== "sql-text-area") return;
  const chart = getSelectedAreaSource(editor, query.props.text, query)?.chart;
  if (!chart) return;
  const bounds = editor.getShapePageBounds(chart.id);
  if (!bounds) return;
  editor.setEditingShape(null);
  editor.select(chart.id);
  editor.zoomToBounds(bounds, { targetZoom: editor.getZoomLevel(), animation: { duration: 200 } });
}
