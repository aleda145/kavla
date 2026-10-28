import type { Editor } from "tldraw";
import type { SQLTextAreaShape } from "../SQLTextArea/sql-text-area-types";
import type { KnobShape } from "../Knob/knob-types";
import type { DataSourceShape } from "../DataSource/data-source-types";
import { dbtState } from "./dbtState";
import { dbtFileView, dbtRelation } from "./dbtCanvas";

// Exclude layout, run status and sync baselines: those change during execution.
export function canvasSQLSignature(editor: Editor): string {
  return JSON.stringify([
    dbtState.get().project?.files.find((file) => file.path === "dbt_project.yml")?.text,
    editor.getCurrentPageShapes().flatMap<(string | null | undefined)[]>((shape) => {
      const file = dbtFileView(shape);
      if (shape.type === "sql-text-area") {
        const query = shape as SQLTextAreaShape;
        return [[shape.id, query.props.name, query.props.text, query.props.dbt?.bindingId, query.props.dbt?.refName]];
      }
      if (shape.type === "data-source") {
        const source = shape as DataSourceShape;
        return [[shape.id, source.props.name, source.props.remoteTableRef, JSON.stringify(dbtRelation(shape))]];
      }
      if (shape.type === "knob") {
        const p = (shape as KnobShape).props;
        return [
          [
            shape.id,
            JSON.stringify([p.name, p.kind, p.value, p.categoryValue, p.categoryAll, p.categoryType, p.temporalType]),
          ],
        ];
      }
      if (file) return [[shape.id, file.props.bindingId, file.props.path, file.props.text]];
      return [];
    }),
  ]);
}

const cache = new WeakMap<Editor, { signature: string; models: Record<string, string> }>();

export function getCompiledDbtModels(editor: Editor): Record<string, string> {
  const entry = cache.get(editor);
  return entry?.signature === canvasSQLSignature(editor) ? entry.models : {};
}

export function rememberCompiledDbtModels(editor: Editor, models: Record<string, string>) {
  cache.set(editor, { signature: canvasSQLSignature(editor), models: { ...getCompiledDbtModels(editor), ...models } });
}
