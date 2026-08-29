import { createShapeId, type Editor, useToasts } from "tldraw";
import { RefreshCw, Search } from "lucide-react";
import { connectShapes } from "../util/shapeConnections";
import { downloadTable, type TableDownloadFormat, type TableDownloadSource } from "../util/downloadTable";
import { TableDownloadButtons } from "@/components/TableDownloadButtons";
import { DuckDBService } from "@/duckdb-service";
import { ensureBundledSourceTable } from "../client/local/bundledTables";
import { downloadSessionBlob, getSessionBlob } from "../client/local/localSession";
import { useData } from "../client/useLocalServer";
import { confirmLargeTableDownload, estimateTableDownloadBytesFromSchema } from "../util/largeTableDownload";
import type { DataSourceShape } from "./data-source-types";

interface DataSourceActionBarProps {
  buttonClassName: string;
  editor: Editor;
  isSelectingSource: boolean;
  onClearSelectedColumns: () => void;
  onKeepCurrentSource: () => void;
  onOpenSourcePicker: () => void;
  selectedColumns: Set<string>;
  shape: DataSourceShape;
}

export function DataSourceActionBar({
  buttonClassName,
  editor,
  isSelectingSource,
  onClearSelectedColumns,
  onKeepCurrentSource,
  onOpenSourcePicker,
  selectedColumns,
  shape,
}: DataSourceActionBarProps) {
  const { addToast } = useToasts();
  const { prepareSourceDownload } = useData();
  const isCliSource = Boolean(shape.props.remoteTableRef);

  const handleDownload = async (format: TableDownloadFormat) => {
    const filename = shape.props.filename;
    if (!filename) return;

    const exactFileSize = shape.props.fileSize;
    const sourceFormat = filename.toLowerCase().endsWith(".csv")
      ? "csv"
      : filename.toLowerCase().endsWith(".parquet")
        ? "parquet"
        : null;
    const isOriginalFileDownload = !isCliSource && sourceFormat === format;
    const schemaEstimate = estimateTableDownloadBytesFromSchema(shape.props.metadata, shape.props.rowCount);
    const estimatedBytes = isOriginalFileDownload ? exactFileSize : (schemaEstimate ?? exactFileSize);
    if (
      !confirmLargeTableDownload({
        bytes: estimatedBytes,
        format,
        subject: "This source",
        isEstimate: !isOriginalFileDownload,
      })
    ) {
      return;
    }

    if (isCliSource) {
      try {
        const download = await prepareSourceDownload({
          tableRef: shape.props.remoteTableRef!,
          format,
          fileName: filename,
          rowCount: shape.props.rowCount,
        });
        const anchor = document.createElement("a");
        anchor.href = download.downloadUrl;
        anchor.download = download.fileName;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
      } catch (error) {
        addToast({
          title: "Download failed",
          description: error instanceof Error ? error.message : String(error),
          severity: "error",
        });
      }
      return;
    }

    const duckDBService = DuckDBService.getInstance();
    const source: TableDownloadSource = {
      kind: "local",
      filename,
      loadOriginalFile: async () => {
        const registeredFile = duckDBService.getRegisteredFile(shape.props.name);
        if (registeredFile) return registeredFile;
        const descriptor = getSessionBlob("source", shape.id);
        if (!descriptor) throw new Error(`The .kavla document does not contain ${filename}.`);
        return downloadSessionBlob(descriptor.id);
      },
      recoverTable: async () => {
        const isAvailable = await ensureBundledSourceTable({
          shapeId: shape.id,
          tableName: shape.props.name,
          filename,
        });
        if (!isAvailable) throw new Error(`The .kavla document does not contain ${filename}.`);
      },
    };

    try {
      await downloadTable({
        format,
        outputBaseName: shape.props.name,
        tableName: shape.props.name,
        source,
        fileSize: shape.props.fileSize,
        onConversionTooLarge: (description) => {
          addToast({
            title: "File too large",
            description,
            severity: "warning",
          });
        },
      });
    } catch (error) {
      addToast({
        title: "Download failed",
        description: error instanceof Error ? error.message : String(error),
        severity: "error",
      });
    }
  };

  const handleQuery = () => {
    const newShapeId = createShapeId();
    let query = `SELECT\n  *\nFROM\n  ${shape.props.name}`;
    let newWidth = 400;

    if (selectedColumns.size > 0) {
      const columns = Array.from(selectedColumns)
        .map((column) => (/\s/.test(column) ? `"${column}"` : column))
        .join(",\n  ");
      query = `SELECT\n  ${columns}\nFROM\n  ${shape.props.name}`;

      const longestColumn = Math.max(...Array.from(selectedColumns, (column) => column.length));
      newWidth = Math.min(Math.max(400, longestColumn * 10 + 120), 800);
    }

    editor.createShape({
      type: "sql-text-area",
      id: newShapeId,
      x: shape.x + shape.props.w + 60,
      y: shape.y,
      props: {
        w: newWidth,
        text: query,
        _isProgrammatic: true,
      },
    });
    connectShapes(editor, shape.id, newShapeId);

    window.setTimeout(() => {
      editor.select(newShapeId);
      editor.zoomToSelection({ animation: { duration: 250 } });
    }, 50);
    onClearSelectedColumns();
  };

  const handleSourceSelection = isSelectingSource ? onKeepCurrentSource : onOpenSourcePicker;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        alignItems: "center",
        padding: 8,
        backgroundColor: "#f3f4f6",
        borderLeft: "4px solid #000",
        gap: 8,
        minWidth: 100,
      }}
    >
      {shape.props.filename && <TableDownloadButtons buttonClassName={buttonClassName} onDownload={handleDownload} />}

      <button
        onClick={handleSourceSelection}
        onPointerDown={(event) => {
          event.stopPropagation();
          if (event.pointerType === "touch") handleSourceSelection();
        }}
        title={isSelectingSource ? "Keep current source" : "Change data source"}
        className={buttonClassName}
        style={{ width: "100%", justifyContent: "center", touchAction: "none", backgroundColor: "#dbeafe" }}
      >
        <RefreshCw size={16} /> {isSelectingSource ? "Keep" : "Change"}
      </button>

      <button
        onClick={handleQuery}
        onPointerDown={(event) => {
          event.stopPropagation();
          if (event.pointerType === "touch") handleQuery();
        }}
        title="Query data"
        className={buttonClassName}
        style={{ width: "100%", justifyContent: "center", touchAction: "none", backgroundColor: "#fef9c3" }}
      >
        <Search size={16} /> {selectedColumns.size > 0 ? "Query These" : "Query"}
      </button>
    </div>
  );
}
