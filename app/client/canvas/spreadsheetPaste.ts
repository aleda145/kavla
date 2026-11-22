import {
  createShapeId,
  defaultHandleExternalTextContent,
  type Editor,
  type TLTextExternalContent,
  type VecLike,
} from "tldraw";
import type { DataSourceShape } from "../../DataSource/data-source-types";
import { clipboardTable, entrySize, saveSpreadsheetEntry } from "../../DataSource/spreadsheet-entry";
import { columnLabel } from "../../DataSource/excel-import";
import { getUniqueName } from "../../util/getUniqueName";

export function registerSpreadsheetPaste(editor: Editor) {
  editor.registerExternalContentHandler("text", (content) => pasteCanvasText(editor, content));

  // Excel may offer an image alongside the cells. The canvas normally prefers the image.
  const handlePaste = (event: ClipboardEvent) => {
    const clipboard = event.clipboardData;
    if (!clipboard || editor.getIsReadonly() || editor.getEditingShapeId() || editor.menus.hasAnyOpenMenus()) return;
    if (
      event.target instanceof HTMLElement &&
      (event.target.isContentEditable || event.target.closest("input, textarea, select, dialog"))
    )
      return;
    const html = clipboard.getData("text/html");
    if (html.includes("data-tldraw") || (!/<table\b/i.test(html) && !clipboard.files.length)) return;
    const rows = clipboardTable(clipboard.getData("text/plain"), html);
    if (!rows) return;
    event.preventDefault();
    event.stopPropagation();
    editor.markHistoryStoppingPoint("paste spreadsheet");
    const atCursor = editor.inputs.shiftKey !== editor.user.getIsPasteAtCursorMode();
    void pasteSpreadsheet(editor, rows, atCursor ? editor.inputs.currentPagePoint : undefined);
  };
  const container = editor.getContainer();
  container.addEventListener("paste", handlePaste, true);
  editor.disposables.add(() => container.removeEventListener("paste", handlePaste, true));
}

function pasteCanvasText(editor: Editor, content: TLTextExternalContent) {
  const plain = content.sources?.find((item) => item.type === "text" && item.subtype === "text");
  const rich = content.sources?.find((item) => item.type === "text" && item.subtype === "html");
  const rows = clipboardTable(
    plain?.type === "text" ? plain.data : content.text,
    rich?.type === "text" ? rich.data : content.html
  );
  if (!rows) return defaultHandleExternalTextContent(editor, content);
  return pasteSpreadsheet(editor, rows, content.point);
}

async function pasteSpreadsheet(
  editor: Editor,
  rows: string[][],
  point: VecLike = editor.getViewportPageBounds().center
) {
  if (editor.isDisposed || editor.getIsReadonly()) return;

  // Keep the first record when a copied range starts with values instead of column names.
  const first = rows[0];
  if (rows.length === 1 || first.some((value) => value.trim() && Number.isFinite(Number(value)))) {
    const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
    rows.unshift(Array.from({ length: width }, (_, col) => `column_${columnLabel(col)}`));
  }

  const id = createShapeId();
  editor.createShape<DataSourceShape>({
    id,
    type: "data-source",
    x: point.x - entrySize.w / 2,
    y: point.y - entrySize.h / 2,
    props: { ...entrySize, name: getUniqueName(editor, "entry", id), entryDraft: rows, isRunning: true },
  });
  editor.select(id);
  try {
    await saveSpreadsheetEntry(editor, id, rows);
  } catch (error) {
    if (!editor.isDisposed && editor.getShape(id)) {
      editor.updateShape<DataSourceShape>({
        id,
        type: "data-source",
        props: {
          error: error instanceof Error ? error.message : String(error),
          isRunning: false,
        },
      });
    }
  }
}
