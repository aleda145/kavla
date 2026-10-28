import type { Editor, TLShape } from "tldraw";
import type { SQLTextAreaShape } from "../SQLTextArea/sql-text-area-types";
import type { DbtFileShape, DbtFileView, DbtDocumentation, DbtMacroShape } from "./dbtTypes";

// File syncing uses one view for legacy file cards and native SQL nodes.
export function dbtFileView(shape: TLShape | undefined): DbtFileView | undefined {
  if (!shape) return undefined;
  if (shape.type === "dbt-file") return shape as DbtFileShape;
  if (shape.type === "dbt-macro") return shape as DbtMacroShape;
  if (shape.type === "sql-text-area") {
    const query = shape as SQLTextAreaShape;
    if (query.props.dbt)
      return { ...query, props: { ...query.props.dbt, w: query.props.w, h: query.props.h, text: query.props.text } };
  }
  return undefined;
}

export function updateDbtFile(editor: Editor, shape: DbtFileView, props: Partial<DbtFileShape["props"]>) {
  if (shape.type === "dbt-file") {
    editor.updateShape<DbtFileShape>({ id: shape.id, type: "dbt-file", props });
    return;
  }
  if (shape.type === "dbt-macro") {
    editor.updateShape<DbtMacroShape>({ id: shape.id, type: "dbt-macro", props });
    return;
  }
  const query = editor.getShape<SQLTextAreaShape>(shape.id);
  if (!query?.props.dbt) return;
  const { text, w, h, ...link } = props;
  editor.updateShape<SQLTextAreaShape>({
    id: query.id,
    type: "sql-text-area",
    props: {
      dbt: { ...query.props.dbt, ...link },
      ...(text === undefined ? {} : { text, ...(text !== query.props.text ? { isDirty: true, stale: true } : {}) }),
      ...(w === undefined ? {} : { w }),
      ...(h === undefined ? {} : { h }),
    },
  });
}

export type DbtRelation = {
  projectRoot?: string;
  bindingId: string;
  projectName: string;
  refName: string;
  source?: string;
  table?: string;
  path?: string;
  revision?: string;
};
export function dbtRelation(shape: TLShape): DbtRelation | undefined {
  if (shape.type === "sql-text-area") {
    const link = (shape as SQLTextAreaShape).props.dbt;
    if (link) return link;
  }
  const meta = shape.meta.dbtRelation;
  if (
    meta &&
    typeof meta === "object" &&
    !Array.isArray(meta) &&
    typeof meta.refName === "string" &&
    typeof meta.bindingId === "string" &&
    typeof meta.projectName === "string"
  )
    return meta as DbtRelation;
  return undefined;
}

export function isDbtMetadataFile(path: string): boolean {
  return /\.ya?ml$/i.test(path) || /(^|\/)readme\.md$/i.test(path);
}

export type DbtHiddenDraft = { id: string; path: string; text: string; projectRoot: string };
export function getDbtHiddenDrafts(editor: Editor): DbtHiddenDraft[] {
  const drafts = editor.getCurrentPage().meta.dbtHiddenDrafts;
  if (!Array.isArray(drafts)) return [];
  return drafts.filter((draft): draft is DbtHiddenDraft =>
    Boolean(
      draft &&
      typeof draft === "object" &&
      !Array.isArray(draft) &&
      typeof draft.id === "string" &&
      typeof draft.path === "string" &&
      typeof draft.text === "string" &&
      typeof draft.projectRoot === "string"
    )
  );
}

export function dbtDocumentation(shape: TLShape): DbtDocumentation | undefined {
  const doc = shape.meta.dbtDocumentation;
  return doc && typeof doc === "object" && !Array.isArray(doc) && Array.isArray(doc.columns)
    ? (doc as DbtDocumentation)
    : undefined;
}
