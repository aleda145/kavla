import { DuckDBService } from "@/duckdb-service";

export type TableDownloadFormat = "csv" | "parquet";

const MAX_BROWSER_CONVERSION_BYTES = 250 * 1024 * 1024;

export type TableDownloadSource =
  | {
      kind: "remote";
      filename: string;
      getUrl: (downloadFilename?: string) => Promise<string>;
    }
  | {
      kind: "local";
      filename: string;
      loadOriginalFile: () => Promise<File>;
      recoverTable?: () => Promise<void>;
    };

interface DownloadTableOptions {
  format: TableDownloadFormat;
  outputBaseName: string;
  tableName: string;
  source: TableDownloadSource;
  fileSize?: number | null;
  onConversionTooLarge?: (description: string) => void;
}

class TableConversionTooLargeError extends Error {
  constructor(
    readonly fileSize: number,
    readonly format: TableDownloadFormat,
    readonly sourceKind: TableDownloadSource["kind"]
  ) {
    super(`Source is too large to convert in the browser (${fileSize} bytes).`);
    this.name = "TableConversionTooLargeError";
  }
}

function startBrowserDownload(url: string, filename: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  startBrowserDownload(url, filename);
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function bufferToBlob(buffer: Uint8Array, format: TableDownloadFormat) {
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  return new Blob([bytes.buffer], {
    type: format === "csv" ? "text/csv" : "application/octet-stream",
  });
}

function filenameHasFormat(filename: string, format: TableDownloadFormat) {
  return filename.toLowerCase().endsWith(`.${format}`);
}

function assertConversionSize(
  fileSize: number | null | undefined,
  format: TableDownloadFormat,
  sourceKind: TableDownloadSource["kind"]
) {
  if (typeof fileSize === "number" && fileSize > MAX_BROWSER_CONVERSION_BYTES) {
    throw new TableConversionTooLargeError(fileSize, format, sourceKind);
  }
}

function getConversionTooLargeDescription(error: TableConversionTooLargeError) {
  const location = error.sourceKind === "remote" ? "remote file" : "file";
  const formatName = error.format === "csv" ? "CSV" : "Parquet";
  const desktopRecommendation = error.format === "parquet" ? " Using a desktop tool is recommended." : "";
  return `This ${location} is too large (>250MB) to convert to ${formatName} in the browser.${desktopRecommendation}`;
}

async function readRemoteFileForConversion(response: Response, format: TableDownloadFormat): Promise<Blob> {
  const contentLengthHeader = response.headers.get("content-length");
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : null;
  assertConversionSize(Number.isFinite(contentLength) ? contentLength : null, format, "remote");

  if (!response.body) {
    const blob = await response.blob();
    assertConversionSize(blob.size, format, "remote");
    return blob;
  }

  const reader = response.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let receivedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    receivedBytes += value.byteLength;
    if (receivedBytes > MAX_BROWSER_CONVERSION_BYTES) {
      await reader.cancel();
      throw new TableConversionTooLargeError(receivedBytes, format, "remote");
    }

    const bytes = new Uint8Array(value.byteLength);
    bytes.set(value);
    chunks.push(bytes.buffer);
  }

  return new Blob(chunks, {
    type: response.headers.get("content-type") || "application/octet-stream",
  });
}

async function convertTable(
  duckDBService: DuckDBService,
  tableName: string,
  format: TableDownloadFormat
): Promise<Uint8Array> {
  return format === "csv" ? duckDBService.convertTableToCSV(tableName) : duckDBService.convertTableToParquet(tableName);
}

async function convertRemoteSource(
  duckDBService: DuckDBService,
  source: Extract<TableDownloadSource, { kind: "remote" }>,
  format: TableDownloadFormat
) {
  const url = await source.getUrl();
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch remote source: ${response.status} ${response.statusText}`);
  }

  const blob = await readRemoteFileForConversion(response, format);
  const file = new File([blob], source.filename);
  const temporaryTableName = `download_${Date.now()}_${crypto.randomUUID().replaceAll("-", "_")}`;

  try {
    await duckDBService.registerFile(temporaryTableName, file);
    return await convertTable(duckDBService, temporaryTableName, format);
  } finally {
    await duckDBService.releaseTable(temporaryTableName);
  }
}

async function convertLocalSource(
  duckDBService: DuckDBService,
  source: Extract<TableDownloadSource, { kind: "local" }>,
  tableName: string,
  format: TableDownloadFormat
) {
  try {
    return await convertTable(duckDBService, tableName, format);
  } catch (error) {
    if (!source.recoverTable) {
      throw error;
    }

    await source.recoverTable();
    return convertTable(duckDBService, tableName, format);
  }
}

export async function downloadTable({
  format,
  outputBaseName,
  tableName,
  source,
  fileSize,
  onConversionTooLarge,
}: DownloadTableOptions): Promise<void> {
  const outputFilename = `${outputBaseName}.${format}`;

  if (filenameHasFormat(source.filename, format)) {
    if (source.kind === "remote") {
      startBrowserDownload(await source.getUrl(outputFilename), outputFilename);
      return;
    }

    try {
      downloadBlob(await source.loadOriginalFile(), outputFilename);
      return;
    } catch {
      // Fall back to exporting the registered table, recovering its
      // registration from the active .kavla document first if possible.
    }
  }

  try {
    let conversionFileSize = fileSize;
    if (
      source.kind === "local" &&
      (typeof conversionFileSize !== "number" || !Number.isFinite(conversionFileSize) || conversionFileSize <= 0)
    ) {
      try {
        conversionFileSize = (await source.loadOriginalFile()).size;
      } catch {
        // The registered table may still be available without the original bundled file.
      }
    }
    assertConversionSize(conversionFileSize, format, source.kind);

    const duckDBService = DuckDBService.getInstance();
    await duckDBService.init();

    const buffer =
      source.kind === "remote"
        ? await convertRemoteSource(duckDBService, source, format)
        : await convertLocalSource(duckDBService, source, tableName, format);

    downloadBlob(bufferToBlob(buffer, format), outputFilename);
  } catch (error) {
    if (error instanceof TableConversionTooLargeError) {
      const description = getConversionTooLargeDescription(error);
      if (onConversionTooLarge) {
        onConversionTooLarge(description);
        return;
      }
    }

    throw error;
  }
}
