const LARGE_TABLE_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const DOWNLOAD_TEXT_ENCODER = new TextEncoder();

type DownloadColumn = {
  name: string;
  type: string;
};

function estimateCellBytes(value: unknown): number {
  if (value === null || value === undefined) return 1;
  if (typeof value === "number" || typeof value === "bigint") return 8;
  if (typeof value === "boolean") return 1;
  if (typeof value === "string") return DOWNLOAD_TEXT_ENCODER.encode(value).byteLength + 2;
  const serialized = JSON.stringify(value, (_key, nestedValue) =>
    typeof nestedValue === "bigint" ? nestedValue.toString() : nestedValue
  );
  return DOWNLOAD_TEXT_ENCODER.encode(serialized ?? String(value)).byteLength + 2;
}

function estimateColumnBytes(type: string): number {
  const normalizedType = type.trim().toUpperCase();
  if (/BOOL/.test(normalizedType)) return 1;
  if (/TINYINT/.test(normalizedType)) return 1;
  if (/SMALLINT/.test(normalizedType)) return 2;
  if (/INTEGER|\bINT\b|FLOAT|REAL|DATE/.test(normalizedType)) return 4;
  if (/BIGINT|DOUBLE|TIME|TIMESTAMP|INTERVAL/.test(normalizedType)) return 8;
  if (/HUGEINT|DECIMAL|UUID/.test(normalizedType)) return 16;
  if (/VARCHAR|CHAR|TEXT|BLOB|JSON|LIST|ARRAY|STRUCT|MAP|UNION/.test(normalizedType)) return 64;
  return 16;
}

export function estimateTableDownloadBytesFromRows(
  rows: Record<string, unknown>[],
  columnNames: string[],
  rowCount: number
): number | null {
  if (rowCount <= 0) return 0;
  if (rows.length === 0 || columnNames.length === 0) return null;

  const sampledBytes = rows.reduce(
    (total, row) =>
      total + columnNames.reduce((rowTotal, columnName) => rowTotal + estimateCellBytes(row[columnName]) + 1, 1),
    0
  );
  const headerBytes = columnNames.reduce((total, columnName) => total + estimateCellBytes(columnName) + 1, 1);
  return headerBytes + (sampledBytes / rows.length) * rowCount;
}

export function estimateTableDownloadBytesFromSchema(
  columns: DownloadColumn[] | null,
  rowCount: number | null
): number | null {
  if (rowCount === null || rowCount < 0 || !columns?.length) return null;
  if (rowCount === 0) return 0;
  const rowBytes = columns.reduce((total, column) => total + estimateColumnBytes(column.type) + 1, 1);
  const headerBytes = columns.reduce(
    (total, column) => total + DOWNLOAD_TEXT_ENCODER.encode(column.name).byteLength + 1,
    1
  );
  return headerBytes + rowBytes * rowCount;
}

function formatEstimatedBytes(bytes: number): string {
  const gigabytes = bytes / LARGE_TABLE_DOWNLOAD_BYTES;
  return `${Number(gigabytes.toPrecision(3))} GB`;
}

export function confirmLargeTableDownload({
  bytes,
  format,
  subject,
  isEstimate = true,
}: {
  bytes: number | null;
  format: "csv" | "parquet";
  subject: string;
  isEstimate?: boolean;
}): boolean {
  if (bytes === null || bytes <= LARGE_TABLE_DOWNLOAD_BYTES) return true;
  return window.confirm(
    `${subject} is ${isEstimate ? "estimated at " : ""}${formatEstimatedBytes(bytes)} before export. Creating the ${
      format === "csv" ? "CSV" : "Parquet"
    } file may use significant CPU, memory, and disk space. Continue?`
  );
}
