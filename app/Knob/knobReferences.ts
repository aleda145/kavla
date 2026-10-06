import type { Editor } from "tldraw";
import type { KnobShape } from "./knob-types";
import { mapKnobParameters } from "./knobSQL";

export function getKnobReferences(sql: string): { name: string; from: number; to: number }[] {
  const references: { name: string; from: number; to: number }[] = [];
  mapKnobParameters(
    sql,
    (name, from) => {
      references.push({ name, from, to: from + name.length + 2 });
      return `{${name}}`;
    },
    true
  );
  return references;
}

export function isKnobCodePosition(sql: string, pos: number): boolean {
  let found = false;
  const marker = "{__kavla_cursor__}";
  mapKnobParameters(sql.slice(0, pos) + marker + sql.slice(pos), (_, offset) => {
    if (offset === pos) found = true;
    return marker;
  });
  return found;
}

export function findKnob(editor: Editor, name: string): KnobShape | undefined {
  return editor
    .getCurrentPageShapes()
    .find(
      (shape): shape is KnobShape =>
        shape.type === "knob" && (shape as KnobShape).props.name.toUpperCase() === name.toUpperCase()
    );
}

export function navigateToKnob(editor: Editor, name: string): void {
  const knob = findKnob(editor, name);
  if (!knob) return;
  const bounds = editor.getShapePageBounds(knob.id);
  if (!bounds) return;
  editor.select(knob.id);
  editor.zoomToBounds(bounds, { targetZoom: editor.getZoomLevel(), animation: { duration: 200 } });
}

export function describeKnob(knob: KnobShape): string {
  return knob.props.kind === "category"
    ? knob.props.categoryValue === ""
      ? "(empty)"
      : (knob.props.categoryValue ?? "Choose a value")
    : String(knob.props.value);
}
