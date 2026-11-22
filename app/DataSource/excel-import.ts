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
    const filled = row.filter((value) => value !== "");
    const next = sheet.rows[index + 1]?.filter((value) => value !== "").length ?? 0;
    const score = filled.length + Math.min(filled.length, next) * 0.5;
    if (score > bestScore) {
      bestScore = score;
      startRow = index;
    }
  });
  let endRow = startRow;
  while (endRow + 1 < sheet.rows.length && sheet.rows[endRow + 1].some((value) => value !== "")) endRow++;
  let startCol = sheet.columnCount;
  let endCol = 0;
  for (let row = startRow; row <= endRow; row++) {
    sheet.rows[row]?.forEach((value, col) => {
      if (value !== "") {
        startCol = Math.min(startCol, col);
        endCol = Math.max(endCol, col);
      }
    });
  }
  startCol = Math.min(startCol, endCol);
  const first = sheet.rows[startRow]?.slice(startCol, endCol + 1).filter(Boolean) ?? [];
  const looksLikeHeader = first.length > 0 && first.every((value) => !/^(?:[-+]?\d[\d.,% ]*|true|false)$/i.test(value));
  return {
    workbookId,
    sheet: sheet.name,
    startRow,
    endRow,
    startCol,
    endCol,
    headerRow: looksLikeHeader ? startRow : null,
    columns: excelColumns(startCol, endCol),
    skipEmptyRows: true,
  };
}

export function selectionPreview(sheet: ExcelSheet, config: ExcelImportConfig) {
  const names = new Set<string>();
  const headers = config.columns.map((col) => {
    const base = (config.headerRow === null ? "" : sheet.rows[config.headerRow]?.[col]?.trim()) || `column_${col + 1}`;
    let name = base;
    for (let suffix = 2; names.has(name.toLowerCase()); suffix++) name = `${base}_${suffix}`;
    names.add(name.toLowerCase());
    return name;
  });
  const rows: string[][] = [];
  let count = 0;
  for (let row = config.headerRow === null ? config.startRow : config.headerRow + 1; row <= config.endRow; row++) {
    if (config.skipEmptyRows && !config.columns.some((col) => (sheet.rows[row]?.[col] ?? "") !== "")) continue;
    count++;
    if (rows.length < 8) rows.push(config.columns.map((col) => sheet.rows[row]?.[col] ?? ""));
  }
  return { headers, rows, count };
}
