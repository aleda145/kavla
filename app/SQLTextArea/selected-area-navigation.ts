import { atom, type Editor, type TLShapeId } from "tldraw";
import { readSelection, type ScatterSelection } from "../Chart/native/selection";

const previews = new WeakMap<Editor, ReturnType<typeof createPreview>>();
const createPreview = () => atom<ScatterSelection | null>("selected area preview", null);

export function selectedAreaPreview(editor: Editor) {
  let preview = previews.get(editor);
  if (!preview) {
    preview = createPreview();
    previews.set(editor, preview);
  }
  return preview;
}

export function navigateToSelectedArea(editor: Editor, queryId: TLShapeId) {
  const query = editor.getShape(queryId);
  const area = readSelection(query?.meta.nativeSelection);
  if (!area) return;
  const chart = editor.getShape(area.chartId as TLShapeId);
  if (!chart || chart.type !== "chart-shape") return;
  const bounds = editor.getShapePageBounds(chart.id);
  if (!bounds) return;
  selectedAreaPreview(editor).set(area);
  editor.setEditingShape(null);
  editor.select(chart.id);
  editor.zoomToBounds(bounds, { targetZoom: editor.getZoomLevel(), animation: { duration: 200 } });
}
