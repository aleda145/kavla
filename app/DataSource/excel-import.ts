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
