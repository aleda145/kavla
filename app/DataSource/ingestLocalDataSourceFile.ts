import type { Editor, TLShapeId } from "tldraw";
import { DuckDBService } from "@/duckdb-service";
import { getUniqueName } from "../util/getUniqueName";
import { toValidSqlName } from "../util/sql";
import type { ColumnMetadata, DataSourceShape } from "./data-source-types";
import { stageSessionBlob } from "../client/local/localSession";

export const MAX_LOCAL_DATA_SOURCE_BYTES = 1024 * 1024 * 1024;

function formatBytes(bytes: number, decimals = 2) {
  if (!bytes) return "0 Bytes";

  const unit = 1024;
  const precision = decimals < 0 ? 0 : decimals;
  const units = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
  const unitIndex = Math.floor(Math.log(bytes) / Math.log(unit));

  return `${parseFloat((bytes / Math.pow(unit, unitIndex)).toFixed(precision))} ${units[unitIndex]}`;
}

export function getLocalDataSourceSizeError(fileSize: number): string | null {
  if (fileSize <= MAX_LOCAL_DATA_SOURCE_BYTES) {
    return null;
  }

  return `File is too large (${formatBytes(
    fileSize
  )}). The current limit for client-side processing is ${formatBytes(MAX_LOCAL_DATA_SOURCE_BYTES)}.`;
}

export function calculateDataSourceHeight(metadata: ColumnMetadata[] | null, rowCount: number | null): number {
  const HEADER_HEIGHT = 42;
  const PADDING = 12;
  const FILE_INFO_HEIGHT = rowCount !== null ? 40 : 0;
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
): Promise<LocalDataSourceProps> {
  const sizeError = getLocalDataSourceSizeError(file.size);
  if (sizeError) {
    throw new Error(sizeError);
  }

  const duckDBService = DuckDBService.getInstance();
  await duckDBService.init();

  await stageSessionBlob({
    id: `source:${shapeId}`,
    kind: "source",
    shapeId,
    file,
  });

  const baseName = file.name.split(".")[0];
  const name = getUniqueName(editor, toValidSqlName(baseName), shapeId);
  await duckDBService.registerFile(name, file);

  const { schema, count } = await duckDBService.getFileMetadata(
    `LOCAL_DATA_SOURCE_${shapeId}_${Date.now()}`,
    name,
    file.name
  );
  const metadata = schema as ColumnMetadata[];

  return {
    columnStats: null,
    error: null,
    fileSize: file.size,
    filename: file.name,
    h: calculateDataSourceHeight(metadata, count),
    isRunning: false,
    metadata,
    name,
    remoteTableRef: null,
    rowCount: count,
    sourceName: null,
    sourceType: null,
    w: calculateDataSourceWidth(metadata, file.name),
  };
}
