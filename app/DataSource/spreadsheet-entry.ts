import { csvFormatRows, csvParseRows, tsvParseRows } from "d3";
import type { Editor, TLShapeId } from "tldraw";
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

export async function saveSpreadsheetEntry(editor: Editor, id: TLShapeId, rows: string[][]) {
  const data = rows.slice(1).filter((row) => row.some((value) => value.trim() !== ""));
  if (!data.length) throw new Error("Enter at least one data row below the column names.");
  let columns = 0;
  for (const row of rows) {
    for (let col = row.length - 1; col >= columns; col--) {
      if (row[col].trim()) {
        columns = col + 1;
        break;
      }
    }
  }
  const headers = Array.from({ length: columns }, (_, col) => rows[0]?.[col]?.trim() || `column_${columnLabel(col)}`);
  if (new Set(headers.map((value) => value.toLowerCase())).size !== columns)
    throw new Error("Give each column a unique name.");
  const csv = csvFormatRows([headers, ...data.map((row) => headers.map((_, col) => row[col] ?? ""))]);
  const before = editor.getShape<DataSourceShape>(id);
  if (before?.props.entryDraft == null) return;
  const file = new File([csv], "entry.kavla-entry.csv", { type: ENTRY_MIME });
  const props = await ingestLocalDataSourceFile(editor, id, file);
  if (editor.isDisposed) return;
  const current = editor.getShape<DataSourceShape>(id);
  if (
    !props ||
    !current ||
    current.props.remoteTableRef !== before.props.remoteTableRef ||
    current.props.entryDraft == null
  )
    return;
  editor.updateShape<DataSourceShape>({
    id,
    type: "data-source",
    props: {
      ...props,
      name: current.props.name,
      w: current.props.w,
      h: current.props.h,
      entryDraft: current.props.entryDraft === before.props.entryDraft ? null : current.props.entryDraft,
    },
  });
}
