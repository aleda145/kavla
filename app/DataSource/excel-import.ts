import type { ColumnMetadata } from "./data-source-types";
import type { KavlaBlobDescriptor } from "../client/local/localSession";

export type ExcelImportConfig = {
  workbookId: string;
  sheet: string;
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  headerRow: number | null;
  columns: number[];
  skipEmptyRows: boolean;
};

export type ExcelSheet = { name: string; rows: string[][]; columnCount: number };
export type ExcelWorkbook = { fileName: string; size: number; sheets: ExcelSheet[] };
export type ExcelImportResult = {
  tableName: string;
  tableRef: string;
  blob: KavlaBlobDescriptor;
  schema: ColumnMetadata[];
  rowCount: number;
  excelImport: ExcelImportConfig;
  fileName: string;
  fileSize: number;
};

export const isExcelFile = (file: File) => /\.(xlsx|xlsm)$/i.test(file.name);
export const excelColumns = (start: number, end: number) =>
  Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => start + i);
export function columnLabel(column: number): string {
  let label = "";
  for (let n = column + 1; n > 0; n = Math.floor((n - 1) / 26))
    label = String.fromCharCode(65 + ((n - 1) % 26)) + label;
  return label;
}
export const cellLabel = (row: number, column: number) => `${columnLabel(column)}${row + 1}`;
export const rangeLabel = (config: ExcelImportConfig) =>
  `${cellLabel(config.startRow, config.startCol)}:${cellLabel(config.endRow, config.endCol)}`;

export function parseCell(label: string): { row: number; col: number } | null {
  const match = /^\$?([A-Z]+)\$?([1-9]\d*)$/i.exec(label.trim());
  if (!match) return null;
  let col = 0;
  for (const char of match[1].toUpperCase()) col = col * 26 + char.charCodeAt(0) - 64;
  return { row: Number(match[2]) - 1, col: col - 1 };
}

export function suggestExcelSelection(sheet: ExcelSheet, workbookId = ""): ExcelImportConfig {
  // Prefer a dense row near the top over a title or note above the table.
  let startRow = 0;
  let bestScore = -1;
  sheet.rows.slice(0, 100).forEach((row, index) => {
    const filled = row.filter((value) => value.trim() !== "");
    const next = sheet.rows[index + 1]?.filter((value) => value.trim() !== "").length ?? 0;
    const score = filled.length + Math.min(filled.length, next) * 0.5;
    if (score > bestScore) {
      bestScore = score;
      startRow = index;
    }
  });
  return {
    workbookId,
    sheet: sheet.name,
    startRow,
    endRow: Math.max(0, sheet.rows.length - 1),
    startCol: 0,
    endCol: Math.max(0, sheet.columnCount - 1),
    headerRow: startRow,
    columns: excelColumns(0, sheet.columnCount - 1),
    skipEmptyRows: true,
  };
}

export function getAutomaticExcelSelection(workbook: ExcelWorkbook): ExcelImportConfig | null {
  // Ignore empty sheets, but never silently choose between multiple tables.
  const sheets = workbook.sheets.filter((sheet) => sheet.rows.some((row) => row.some((value) => value.trim() !== "")));
  if (sheets.length !== 1) return null;
  const sheet = sheets[0];
  const headers = sheet.rows[0]?.map((value) => value.trim()) ?? [];
  if (!headers.length || headers.length !== sheet.columnCount) return null;
  const names = new Set<string>();
  for (const header of headers) {
    const name = header.toLowerCase();
    if (
      !/\p{L}/u.test(header) ||
      Number.isFinite(Number(header)) ||
      /^\d{4}-\d{2}-\d{2}(?:$|[T ])/i.test(header) ||
      /[\r\n]/.test(header) ||
      header.length > 128 ||
      /^(?:true|false|null|nan|undefined|#[\w/?!]+)$/i.test(header) ||
      names.has(name)
    )
      return null;
    names.add(name);
  }

  let endRow = sheet.rows.length - 1;
  while (endRow > 0 && sheet.rows[endRow].every((value) => value.trim() === "")) endRow--;
  if (endRow < 1) return null;

  // Inspect every row, including far below the first apparent table. Missing
  // cells are normal CSV data; Excel may omit trailing empty cells entirely.
  // Empty separators or repeated headers still suggest separate data blocks.
  for (let index = 1; index <= endRow; index++) {
    const row = sheet.rows[index];
    if (row.length > headers.length || row.every((value) => value.trim() === "")) return null;
    if (headers.every((header, col) => (row[col] ?? "").trim().toLowerCase() === header.toLowerCase())) return null;
  }

  return {
    workbookId: "",
    sheet: sheet.name,
    startRow: 0,
    endRow,
    startCol: 0,
    endCol: headers.length - 1,
    headerRow: 0,
    columns: excelColumns(0, headers.length - 1),
    skipEmptyRows: true,
  };
}
