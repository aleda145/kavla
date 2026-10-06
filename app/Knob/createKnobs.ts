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
      const x = (bounds?.x ?? query.x) - 300;
      let y = bounds?.y ?? query.y;
      const occupied = editor.getCurrentPageShapes().map((shape) => editor.getShapePageBounds(shape.id));
      while (occupied.some((box) => box && box.x < x + 240 && box.maxX > x && box.y < y + 126 && box.maxY > y))
        y += 150;
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
