import { createShapeId, type Editor, type TLShapeId } from "tldraw";
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

export function getKnobPlacement(editor: Editor, anchorId: TLShapeId): { x: number; y: number } {
  const anchor = editor.getShapePageBounds(anchorId);
  if (!anchor) throw new Error("Cannot place a knob without anchor bounds.");
  const width = 240;
  const height = 126;
  const gap = 16;
  const target = { x: anchor.center.x - width / 2, y: anchor.center.y - height / 2 };
  // These rectangles describe forbidden positions for the knob's top-left corner.
  const occupied = editor
    .getCurrentPageShapes()
    .filter((shape) => shape.type !== "arrow")
    .flatMap((shape) => {
      const bounds = editor.getShapePageBounds(shape.id);
      return bounds
        ? [
            {
              minX: bounds.minX - width - gap,
              maxX: bounds.maxX + gap,
              minY: bounds.minY - height - gap,
              maxY: bounds.maxY + gap,
            },
          ]
        : [];
    })
    .sort((a, b) => a.minY - b.minY);
  const xs = [...new Set([target.x, ...occupied.flatMap((box) => [box.minX, box.maxX])])].sort(
    (a, b) => Math.abs(a - target.x) - Math.abs(b - target.x)
  );
  let best = target;
  let bestDistance = Infinity;
  // A nearest free position lies on an obstacle edge or aligns with the target.
  for (const x of xs) {
    const dx = x - target.x;
    if (dx * dx > bestDistance) break;
    const intervals: { min: number; max: number }[] = [];
    for (const box of occupied) {
      if (x <= box.minX || x >= box.maxX) continue;
      const previous = intervals[intervals.length - 1];
      if (previous && box.minY < previous.max) previous.max = Math.max(previous.max, box.maxY);
      else intervals.push({ min: box.minY, max: box.maxY });
    }
    const blocked = intervals.find((interval) => target.y > interval.min && target.y < interval.max);
    const y = blocked ? (target.y - blocked.min <= blocked.max - target.y ? blocked.min : blocked.max) : target.y;
    const distance = dx * dx + (y - target.y) ** 2;
    if (distance < bestDistance) {
      best = { x, y };
      bestDistance = distance;
    }
  }
  return best;
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
      const { x, y } = getKnobPlacement(editor, query.id);
      editor.createShape<KnobShape>({
        id,
        type: "knob",
        parentId: editor.getCurrentPageId(),
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
