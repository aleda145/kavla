import type { Editor, TLShapeId } from "tldraw";
import { backendRequest, withBackendActivity } from "../client/backendCompute";
import { getUniqueName } from "../util/getUniqueName";
import { toValidSqlName } from "../util/sql";
import type { ColumnMetadata, DataSourceShape } from "./data-source-types";
import { rememberUploadedBlob, type KavlaBlobDescriptor } from "../client/local/localSession";
import { isExcelFile, type ExcelImportConfig, type ExcelImportResult } from "./excel-import";
import { openExcelImport } from "./ExcelImportDialog";

export function calculateDataSourceHeight(metadata: ColumnMetadata[] | null, showRowInfo: boolean): number {
  const HEADER_HEIGHT = 42;
  const PADDING = 12;
  const FILE_INFO_HEIGHT = showRowInfo ? 40 : 0;
  const TABLE_HEADER_HEIGHT = 28;
  const TABLE_ROW_HEIGHT = 24;
  const TABLE_MARGIN_TOP = 12;

  let tableHeight = 0;
  if (metadata && metadata.length > 0) {
    tableHeight = TABLE_HEADER_HEIGHT + metadata.length * TABLE_ROW_HEIGHT + TABLE_MARGIN_TOP;
  }

  const totalHeight = HEADER_HEIGHT + PADDING + FILE_INFO_HEIGHT + tableHeight + PADDING + TABLE_ROW_HEIGHT;
  return Math.max(450, Math.min(800, totalHeight));
}

export function calculateDataSourceWidth(metadata: ColumnMetadata[] | null, filename: string | null): number {
  const MIN_WIDTH = 400;
  const MAX_WIDTH = 600;
  const BASE_PADDING = 100;
  const CHAR_WIDTH = 8;

  let requiredWidth = MIN_WIDTH;

  if (!metadata || metadata.length === 0) {
    return MIN_WIDTH;
  }

  if (filename) {
    requiredWidth = Math.max(requiredWidth, filename.length * CHAR_WIDTH + BASE_PADDING + 40);
  }

  for (const column of metadata) {
    const nameWidth = Math.min(column.name.length * CHAR_WIDTH, 150);
    requiredWidth = Math.max(requiredWidth, nameWidth + column.type.length * CHAR_WIDTH + 140);
  }

  return Math.min(Math.max(MIN_WIDTH, requiredWidth), MAX_WIDTH);
}

type LocalDataSourceProps = Pick<
  DataSourceShape["props"],
  | "columnStats"
  | "error"
  | "fileSize"
  | "filename"
  | "excelImport"
  | "h"
  | "isRunning"
  | "metadata"
  | "name"
  | "remoteTableRef"
  | "rowCount"
  | "sourceName"
  | "sourceType"
  | "w"
>;

export async function ingestLocalDataSourceFile(
  editor: Editor,
  shapeId: TLShapeId,
  file: File
): Promise<LocalDataSourceProps | null> {
  if (isExcelFile(file)) {
    const result = await openExcelImport({ file, autoDetect: true });
    return result ? excelDataSourceProps(editor, shapeId, result) : null;
  }
  const result = await withBackendActivity(async () => {
    const response = await backendRequest(`/api/session/uploads?${new URLSearchParams({ fileName: file.name })}`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    return (await response.json()) as {
      tableName: string;
      tableRef: string;
      blob: KavlaBlobDescriptor;
      schema: ColumnMetadata[];
      rowCount: number;
    };
  });
  rememberUploadedBlob(result.blob);
  const name = getUniqueName(editor, toValidSqlName(result.tableName), shapeId);
  const metadata = result.schema;
  const count = result.rowCount;

  return {
    columnStats: null,
    error: null,
    fileSize: file.size,
    filename: file.name,
    h: calculateDataSourceHeight(metadata, true),
    excelImport: null,
    isRunning: false,
    metadata,
    name,
    remoteTableRef: result.tableRef,
    rowCount: count,
    sourceName: "uploaded_files",
    sourceType: "duckdb",
    w: calculateDataSourceWidth(metadata, file.name),
  };
}

function excelDataSourceProps(editor: Editor, shapeId: TLShapeId, result: ExcelImportResult): LocalDataSourceProps {
  rememberUploadedBlob(result.blob);
  return {
    columnStats: null,
    error: null,
    fileSize: result.fileSize,
    filename: result.fileName,
    excelImport: result.excelImport,
    h: calculateDataSourceHeight(result.schema, result.rowCount),
    w: calculateDataSourceWidth(result.schema, result.fileName),
    isRunning: false,
    metadata: result.schema,
    name: getUniqueName(editor, toValidSqlName(result.tableName), shapeId),
    remoteTableRef: result.tableRef,
    rowCount: result.rowCount,
    sourceName: "uploaded_files",
    sourceType: "duckdb",
  };
}

export async function reimportExcelDataSource(
  editor: Editor,
  shapeId: TLShapeId,
  config: ExcelImportConfig
): Promise<LocalDataSourceProps | null> {
  const result = await openExcelImport({ config });
  return result ? excelDataSourceProps(editor, shapeId, result) : null;
}
