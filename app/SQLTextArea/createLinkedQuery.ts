import { createShapeId, type Editor, type TLShapeId } from "tldraw";
import { getFallbackNodePosition } from "../client/canvas/fallbackNodePosition";
import { connectShapes } from "../util/shapeConnections";
import type { SQLTextAreaShape } from "./sql-text-area-types";

export function createLinkedQuery(
  editor: Editor,
  sourceId: TLShapeId,
  props: Partial<SQLTextAreaShape["props"]> & { text: string },
  options: { meta?: SQLTextAreaShape["meta"]; focus?: boolean } = {}
) {
  const id = createShapeId();
  editor.run(() => {
    editor.createShape<SQLTextAreaShape>({
      type: "sql-text-area",
      id,
      ...getFallbackNodePosition(editor, sourceId),
      props,
      meta: options.meta ?? {},
    });
    connectShapes(editor, sourceId, id);
  });
  if (options.focus !== false) {
    setTimeout(() => {
      if (editor.isDisposed || !editor.getCurrentPageShapeIds().has(id)) return;
      editor.select(id);
      editor.zoomToSelection({ animation: { duration: 250 } });
    }, 50);
  }
  return id;
}
