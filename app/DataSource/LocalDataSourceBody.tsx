import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { Editor } from "tldraw";
import { useData, type CliSource } from "../client/useLocalServer";
import { SchemaTable } from "./ColumnProfileTable";
import { DataSourcePicker } from "./CliSourcesList";
import { DataSourceActionBar } from "./DataSourceActionBar";
import { RemoteTablesList } from "./RemoteTablesList";
import type { RemoteSourceMetadata } from "./remote-source-metadata";
import type { DataSourceShape } from "./data-source-types";
import type { useTldrawScrollArea } from "./useTldrawScrollArea";
import { TldrawScrollAreaIndicator } from "./TldrawScrollAreaIndicator";

const buttonClass =
  "h-9 px-3 border-2 border-black text-black font-bold text-xs flex items-center justify-center gap-2 rounded cursor-pointer shadow-[2px_2px_0px_0px_rgba(0,0,0,0.2)] hover:shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] transition-all active:translate-y-[1px]";

function formatBytes(bytes: number): string {
  if (!bytes) return "0 Bytes";
  const units = ["Bytes", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${parseFloat((bytes / Math.pow(1024, index)).toFixed(2))} ${units[index]}`;
}

interface LocalDataSourceBodyProps {
  cancelRemoteQuery: ReturnType<typeof useData>["cancelRemoteQuery"];
  cliSources: CliSource[];
  editor: Editor;
  onClearSelectedColumns: () => void;
  onColumnClick: (columnName: string, shiftKey: boolean) => void;
  onLocalFilePickerOpen: () => void;
  onRemoteTableSelect: (sourceName: string, table: string) => void;
  remoteSourceInfo: RemoteSourceMetadata | null;
  remoteTableDisplayName: string | null;
  runRemoteQuery: ReturnType<typeof useData>["runRemoteQuery"];
  schemaScrollArea: ReturnType<typeof useTldrawScrollArea>;
  selectedColumns: Set<string>;
  shape: DataSourceShape;
}

export function LocalDataSourceBody({
  cancelRemoteQuery,
  cliSources,
  editor,
  onClearSelectedColumns,
  onColumnClick,
  onLocalFilePickerOpen,
  onRemoteTableSelect,
  remoteSourceInfo,
  remoteTableDisplayName,
  runRemoteQuery,
  schemaScrollArea,
  selectedColumns,
  shape,
}: LocalDataSourceBodyProps) {
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [tables, setTables] = useState<string[] | null>(null);
  const [tableError, setTableError] = useState<string | null>(null);
  const [loadingTables, setLoadingTables] = useState(false);
  const [isSelectingSource, setIsSelectingSource] = useState(false);
  const { getSourceTables } = useData();
  const hasSource = Boolean(shape.props.filename);
  const showSourcePicker = isSelectingSource || !hasSource;

  const resetPicker = () => {
    setSelectedSource(null);
    setTables(null);
    setTableError(null);
  };

  useEffect(() => {
    setIsSelectingSource(false);
    resetPicker();
  }, [shape.props.filename, shape.props.remoteTableRef, shape.props.sourceName]);

  const openSource = async (sourceName: string) => {
    setSelectedSource(sourceName);
    setLoadingTables(true);
    setTableError(null);
    try {
      const result = await getSourceTables({ sourceName });
      setTables(result.tables);
    } catch (error) {
      setTables([]);
      setTableError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingTables(false);
    }
  };

  const selectRemoteTable = (table: string) => {
    if (!selectedSource) return;
    const sourceName = selectedSource;
    setIsSelectingSource(false);
    resetPicker();
    onRemoteTableSelect(sourceName, table);
  };

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <div style={{ flex: 1, display: "flex", minWidth: 0, flexDirection: "column", overflow: "hidden", fontSize: 13 }}>
        {showSourcePicker ? (
          <div className="flex min-h-0 flex-1 flex-col">
            {selectedSource ? (
              <RemoteTablesList
                isLoading={loadingTables}
                onBack={() => setSelectedSource(null)}
                onTableSelect={selectRemoteTable}
                selectedRemoteSource={selectedSource}
                remoteTables={tables}
                sourceError={tableError}
                cliSources={cliSources}
              />
            ) : (
              <DataSourcePicker
                sources={cliSources}
                onFileClick={onLocalFilePickerOpen}
                onSourceClick={(sourceName) => void openSource(sourceName)}
              />
            )}
          </div>
        ) : (
          <>
            <div style={{ flexShrink: 0, padding: "12px 12px 0", marginBottom: 12 }}>
              <div>
                <strong>{remoteSourceInfo ? "Table:" : "File:"}</strong>{" "}
                {remoteSourceInfo ? remoteTableDisplayName : shape.props.filename}
              </div>
              {shape.props.rowCount !== null && (
                <div>
                  <strong>Rows:</strong> {shape.props.rowCount.toLocaleString()}
                </div>
              )}
              {shape.props.metadata && (
                <div>
                  <strong>Columns:</strong> {shape.props.metadata.length.toLocaleString()}
                </div>
              )}
              {!remoteSourceInfo && shape.props.fileSize !== null && (
                <div>
                  <strong>Size:</strong> {formatBytes(shape.props.fileSize)}
                </div>
              )}
            </div>
            {shape.props.isRunning ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 font-bold">
                <Loader2 className="animate-spin" size={24} /> Loading data…
              </div>
            ) : shape.props.metadata?.length ? (
              <div
                ref={schemaScrollArea.ref}
                onPointerDown={schemaScrollArea.onPointerDown}
                onPointerMove={schemaScrollArea.onPointerMove}
                onPointerUp={schemaScrollArea.onPointerUp}
                onPointerCancel={schemaScrollArea.onPointerCancel}
                onWheel={schemaScrollArea.onWheel}
                className="mx-3 mb-3 min-h-0 flex-1 overflow-y-auto rounded border-2 border-black bg-white"
              >
                <SchemaTable
                  metadata={shape.props.metadata}
                  selectedColumns={selectedColumns}
                  onColumnClick={onColumnClick}
                  tableName={shape.props.name}
                  columnStats={shape.props.columnStats}
                  remoteSource={
                    remoteSourceInfo
                      ? {
                          sourceName: remoteSourceInfo.sourceName,
                          sourceType: remoteSourceInfo.sourceType,
                          fullTableRef: remoteSourceInfo.remoteTableRef,
                          runRemoteQuery,
                          cancelRemoteQuery,
                        }
                      : null
                  }
                />
                <TldrawScrollAreaIndicator indicator={schemaScrollArea.indicator} />
              </div>
            ) : null}
          </>
        )}
      </div>

      {hasSource && (
        <DataSourceActionBar
          buttonClassName={buttonClass}
          editor={editor}
          isSelectingSource={isSelectingSource}
          onClearSelectedColumns={onClearSelectedColumns}
          onKeepCurrentSource={() => {
            setIsSelectingSource(false);
            resetPicker();
          }}
          onOpenSourcePicker={() => {
            setIsSelectingSource(true);
            resetPicker();
          }}
          selectedColumns={selectedColumns}
          shape={shape}
        />
      )}
    </div>
  );
}
