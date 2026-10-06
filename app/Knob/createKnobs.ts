import { createShapeId, type Editor } from "tldraw";
import type { SQLTextAreaShape } from "../SQLTextArea/sql-text-area-types";
import { connectShapes } from "../util/shapeConnections";
import type { KnobShape } from "./knob-types";
import { mapKnobParameters } from "./knobSQL";

export function getUniqueKnobName(editor: Editor, desired: string, exceptId?: string): string {
  const names = new Set(
    editor
      .getCurrentPageShapes()
      .filter((shape): shape is KnobShape => shape.type === "knob" && shape.id !== exceptId)
      .map((shape) => shape.props.name.toUpperCase())
  );
  let name = desired;
  let counter = 1;
  while (names.has(name.toUpperCase())) name = `${desired}_${counter++}`;
  return name;
}

export function ensureQueryKnobs(editor: Editor, query: SQLTextAreaShape, text: string): void {
  if (editor.getInstanceState().isReadonly) return;
  const names = new Map<string, string>();
  mapKnobParameters(text, (name) => {
    names.set(name.toUpperCase(), name);
    return `{${name}}`;
  });
  editor.run(() => {
    for (const [key, name] of names) {
      const existing = editor
        .getCurrentPageShapes()
        .find((shape) => shape.type === "knob" && (shape as KnobShape).props.name.toUpperCase() === key);
      if (existing) {
        connectShapes(editor, existing.id, query.id);
        continue;
      }
      const id = createShapeId();
      const bounds = editor.getShapePageBounds(query.id);
      const width = 240;
      const height = 126;
      const gap = 16;
      const left = (bounds?.x ?? query.x) - width / 2;
      const top = (bounds?.y ?? query.y) - height - gap - 80;
      const columns = Math.max(1, Math.floor(((bounds?.width ?? query.props.w) + width / 2 + gap) / (width + gap)));
      const occupied = editor
        .getCurrentPageShapes()
        .filter((shape) => shape.type !== "arrow")
        .map((shape) => editor.getShapePageBounds(shape.id));
      let slot = 0;
      let x = left;
      let y = top;
      while (
        occupied.some(
          (box) =>
            box && box.x < x + width + gap && box.maxX > x - gap && box.y < y + height + gap && box.maxY > y - gap
        )
      ) {
        slot++;
        x = left + (slot % columns) * (width + gap);
        y = top - Math.floor(slot / columns) * (height + gap);
      }
      editor.createShape<KnobShape>({
        id,
        type: "knob",
        x,
        y,
        props: {
          name,
          inferFromColumn: true,
          inferenceQueryId: query.id,
        },
      });
      connectShapes(editor, id, query.id);
    }
  });
}
