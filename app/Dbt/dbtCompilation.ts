import { atom, type Editor } from "tldraw";
import type { SQLTextAreaShape } from "../SQLTextArea/sql-text-area-types";
import type { KnobShape } from "../Knob/knob-types";
import type { DataSourceShape } from "../DataSource/data-source-types";
import { dbtState } from "./dbtState";
import { dbtFileView, dbtRelation } from "./dbtCanvas";

// Exclude layout, run status and sync baselines: those change during execution.
export function canvasSQLSignature(editor: Editor): string {
  return JSON.stringify([
    dbtState.get().project?.binding?.id,
    dbtState.get().project?.files.find((file) => file.path === "dbt_project.yml")?.text,
    editor.getCurrentPageShapes().flatMap<(string | null | undefined)[]>((shape) => {
      const file = dbtFileView(shape);
      if (shape.type === "sql-text-area") {
        const query = shape as SQLTextAreaShape;
        return [
          [
            shape.id,
            query.props.name,
            query.props.text,
            query.props.dbt?.bindingId,
            query.props.dbt?.projectName,
            query.props.dbt?.refName,
            String(query.props.dbt?.readOnly ?? false),
          ],
        ];
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

const cache = new WeakMap<
  Editor,
  { signature: string; models: Record<string, string>; queries: Map<string, string> }
>();
const compilationRevision = atom("Compiled dbt SQL revision", 0);

export function getCompiledDbtModels(editor: Editor): Record<string, string> {
  compilationRevision.get();
  const entry = cache.get(editor);
  return entry?.signature === canvasSQLSignature(editor) ? entry.models : {};
}

export function getCompiledDbtQuery(editor: Editor, sql: string): string | undefined {
  compilationRevision.get();
  const entry = cache.get(editor);
  if (entry?.signature !== canvasSQLSignature(editor)) return undefined;
  const query = entry.queries.get(sql);
  if (query !== undefined) return query;
  const shape = editor
    .getCurrentPageShapes()
    .find((shape) => shape.type === "sql-text-area" && (shape as SQLTextAreaShape).props.text === sql);
  return shape ? entry.models[shape.id] : undefined;
}

export function rememberCompiledDbtModels(
  editor: Editor,
  models: Record<string, string>,
  query?: { source: string; sql: string }
) {
  const signature = canvasSQLSignature(editor);
  const previous = cache.get(editor);
  const queries = new Map(previous?.signature === signature ? previous.queries : []);
  if (query) queries.set(query.source, query.sql);
  cache.set(editor, { signature, models: { ...getCompiledDbtModels(editor), ...models }, queries });
  compilationRevision.set(compilationRevision.get() + 1);
}
