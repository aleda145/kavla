import { csvFormatRows, csvParseRows, tsvParseRows } from "d3";
import { react, type Editor, type TLShapeId } from "tldraw";
import { columnLabel } from "./excel-import";
import type { DataSourceShape } from "./data-source-types";
import { ingestLocalDataSourceFile } from "./ingestLocalDataSourceFile";

export const ENTRY_MIME = "application/vnd.kavla.entry+csv";
export const entrySize = { w: 800, h: 400 };

export function clipboardTable(text: string, html?: string): string[][] | null {
  if (text.includes("\t")) {
    const rows = tsvParseRows(text);
    if (rows.some((row) => row.length >= 2)) return rows;
  }
  if (html && /<table\b/i.test(html)) {
    const template = document.createElement("template");
    template.innerHTML = html;
    const tables = template.content.querySelectorAll("table");
    if (tables.length === 1) {
      const rows = Array.from(tables[0].rows, (row) => Array.from(row.cells, (cell) => cell.textContent ?? ""));
      if (rows.length > 1 || rows[0]?.length > 1) return rows;
    }
  }
  if (text.includes(",") && /[\r\n]/.test(text)) {
    const rows = csvParseRows(text);
    if (rows.length > 1 && rows[0].length > 1 && rows.every((row) => row.length === rows[0].length)) return rows;
  }
  return null;
}

export function isEntryDirty(props: DataSourceShape["props"]): boolean {
  return props.entryDraft != null && (props.entryDirty ?? props.entryDraft.length > 0);
}

class EntryValidationError extends Error {}

async function saveSpreadsheetEntry(editor: Editor, id: TLShapeId, rows: string[][], isCurrent: () => boolean) {
  const before = editor.getShape<DataSourceShape>(id);
  if (!before || before.props.entryDraft !== rows) return;
  const data = rows.slice(1).filter((row) => row.some((value) => value.trim() !== ""));
  let columns = 0;
  for (const row of rows) {
    for (let col = row.length - 1; col >= columns; col--) {
      if (row[col].trim()) {
        columns = col + 1;
        break;
      }
    }
  }
  if (!columns && !before.props.remoteTableRef) {
    editor.run(
      () =>
        editor.updateShape<DataSourceShape>({
          id,
          type: "data-source",
          props: { entryDirty: false, error: null },
        }),
      { history: "ignore", ignoreShapeLock: true }
    );
    return;
  }
  // Clearing a published sheet also clears its queryable rows.
  const headers = columns
    ? Array.from({ length: columns }, (_, col) => rows[0]?.[col]?.trim() || `column_${columnLabel(col)}`)
    : (before.props.metadata?.map((column) => column.name) ?? []);
  if (!headers.length) headers.push("column_A");
  if (new Set(headers.map((value) => value.toLowerCase())).size !== headers.length)
    throw new EntryValidationError("Give each column a unique name.");
  const csv = csvFormatRows([headers, ...data.map((row) => headers.map((_, col) => row[col] ?? ""))]) + "\n";
  const file = new File([csv], "entry.kavla-entry.csv", { type: ENTRY_MIME });
  const props = await ingestLocalDataSourceFile(editor, id, file);
  if (!isCurrent() || editor.isDisposed || editor.getIsReadonly()) return;
  const current = editor.getShape<DataSourceShape>(id);
  if (
    !props ||
    !current ||
    current.props.remoteTableRef !== before.props.remoteTableRef ||
    current.props.entryDraft !== rows ||
    !isEntryDirty(current.props)
  )
    return;

  editor.run(
    () =>
      editor.updateShape<DataSourceShape>({
        id,
        type: "data-source",
        props: { ...props, name: current.props.name, w: current.props.w, h: current.props.h, entryDirty: false },
      }),
    { history: "ignore", ignoreShapeLock: true }
  );
}

export function registerEntryAutosave(editor: Editor) {
  const sources = editor.store.query.records("shape", () => ({ type: { eq: "data-source" } }));
  const scheduled = new Map<TLShapeId, { rows: string[][]; timer: ReturnType<typeof setTimeout> }>();
  const inFlight = new Map<TLShapeId, Promise<void>>();
  const stop = react("autosave spreadsheet edits", () => {
    const dirty = new Map<TLShapeId, string[][]>();
    if (!editor.getIsReadonly()) {
      for (const record of sources.get()) {
        const shape = record as DataSourceShape;
        if (isEntryDirty(shape.props) && !shape.props.isRunning) {
          dirty.set(shape.id, shape.props.entryDraft!);
        }
      }
    }
    for (const [id, job] of scheduled) {
      if (dirty.get(id) !== job.rows) {
        clearTimeout(job.timer);
        scheduled.delete(id);
      }
    }
    for (const [id, rows] of dirty) {
      if (scheduled.has(id)) continue;
      let retryDelay = 2000;
      async function publish() {
        await inFlight.get(id);
        const job = scheduled.get(id);
        if (!job || job.rows !== rows || editor.isDisposed || editor.getIsReadonly()) return;
        const operation = saveSpreadsheetEntry(editor, id, rows, () => scheduled.get(id) === job).catch(
          (reason: unknown) => {
            if (
              scheduled.get(id) !== job ||
              editor.isDisposed ||
              editor.getIsReadonly() ||
              editor.getShape<DataSourceShape>(id)?.props.entryDraft !== rows
            )
              return;
            const message = reason instanceof Error ? reason.message : String(reason);
            editor.run(
              () =>
                editor.updateShape<DataSourceShape>({
                  id,
                  type: "data-source",
                  props: { error: `Sheet autosave: ${message}` },
                }),
              { history: "ignore", ignoreShapeLock: true }
            );
            if (!(reason instanceof EntryValidationError)) {
              job.timer = setTimeout(publish, retryDelay);
              retryDelay = Math.min(retryDelay * 2, 30000);
            }
          }
        );
        inFlight.set(id, operation);
        try {
          await operation;
        } finally {
          if (inFlight.get(id) === operation) inFlight.delete(id);
        }
      }
      scheduled.set(id, { rows, timer: setTimeout(publish, 800) });
    }
  });
  return () => {
    stop();
    for (const job of scheduled.values()) clearTimeout(job.timer);
    scheduled.clear();
  };
}
