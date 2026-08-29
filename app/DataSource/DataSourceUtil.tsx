import { HTMLContainer, Rectangle2d, ShapeUtil, TLResizeInfo, getDefaultColorTheme, resizeBox } from "tldraw";
import { DataSourceShape } from "./data-source-types";
import { DataSourceProps } from "./data-source-props";
import { DataSourceMigrations } from "./data-source-migrations";
import { useEffect, useRef, useState } from "react";
import { getCliSourcesSnapshot, useData, useCliSources } from "../client/useLocalServer";
import { getUniqueName } from "../util/getUniqueName";
import { toValidSqlName } from "../util/sql";
import { quoteDottedIdentifier } from "../src/duckdb/sql";
import { DuckDBService } from "@/duckdb-service";
import { useTldrawScrollArea } from "./useTldrawScrollArea";
import { getRemoteSourceMetadata, getRemoteTableDisplayName } from "./remote-source-metadata";
import { DataSourceHeader } from "./DataSourceHeader";
import { LocalDataSourceBody as DataSourceBody } from "./LocalDataSourceBody";
import { ensureBundledSourceTable } from "../client/local/bundledTables";
import {
  calculateDataSourceHeight,
  calculateDataSourceWidth,
  getLocalDataSourceSizeError,
  ingestLocalDataSourceFile,
} from "./ingestLocalDataSourceFile";
import { getEngineAppearance, ShapeEngineTabs, type ShapeEngineTab } from "../util/ShapeEngineTabs";
import { calculateDataSourcePickerHeight, DATA_SOURCE_PICKER_WIDTH } from "./CliSourcesList";

type SourceChangeOptions = {
  filename: string;
  name?: string;
  fileSize?: number | null;
  sourceName?: string | null;
  sourceType?: string | null;
  remoteTableRef?: string | null;
};

function getLocalSourceType(filename: string | null): string | null {
  const extension = filename?.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? null;
  return extension === "csv" || extension === "parquet" || extension === "json" ? extension : null;
}

export class DataSourceUtil extends ShapeUtil<DataSourceShape> {
  static override type = "data-source" as const;
  static override props = DataSourceProps;
  static override migrations = DataSourceMigrations;

  private updateSourceName: ((payload: { prevName: string; nextName: string }) => void) | null = null;

  override isAspectRatioLocked(_shape: DataSourceShape) {
    return false;
  }

  override canResize(_shape: DataSourceShape) {
    return true;
  }

  getDefaultProps(): DataSourceShape["props"] {
    return {
      w: DATA_SOURCE_PICKER_WIDTH,
      h: calculateDataSourcePickerHeight(getCliSourcesSnapshot().length),
      color: "black",
      text: "Source",
      error: null,
      isRunning: false,
      name: "Source",
      filename: null,
      sourceName: null,
      sourceType: null,
      remoteTableRef: null,
      rowCount: null,
      downstreamShapeIds: null,
      upstreamShapeIds: null,
      metadata: null,
      fileSize: null,
      columnStats: null,
    };
  }

  getGeometry(shape: DataSourceShape) {
    return new Rectangle2d({
      width: shape.props.w,
      height: shape.props.h,
      isFilled: true,
    });
  }

  component(shape: DataSourceShape) {
    const theme = getDefaultColorTheme({
      isDarkMode: this.editor.user.getIsDarkMode(),
    });
    const { updateSourceName, getSourceSchema, getSourceStats, runRemoteQuery, cancelRemoteQuery } = useData();
    this.updateSourceName = updateSourceName;

    const [selectedColumns, setSelectedColumns] = useState<Set<string>>(new Set());
    const remoteMetadataAttemptRef = useRef<string | null>(null);

    const handleColumnClick = (columnName: string, _shiftKey: boolean) => {
      setSelectedColumns((prev) => {
        const next = new Set(prev);
        if (next.has(columnName)) {
          next.delete(columnName);
        } else {
          next.add(columnName);
        }
        return next;
      });
    };

    const cliSources = useCliSources();
    const remoteSourceInfo = getRemoteSourceMetadata(shape);
    const remoteTableDisplayName = remoteSourceInfo ? getRemoteTableDisplayName(remoteSourceInfo.remoteTableRef) : null;
    const sourceType = remoteSourceInfo?.sourceType?.toLowerCase() ?? getLocalSourceType(shape.props.filename);
    const sourceAppearance = sourceType ? getEngineAppearance(sourceType) : null;
    const sourceTabs: ShapeEngineTab[] = sourceType
      ? [
          {
            key: `data-source-${sourceType}`,
            type: sourceType,
            active: true,
            layerZIndex: 0,
            title: remoteSourceInfo
              ? `${sourceAppearance?.label ?? "Remote"} source via CLI`
              : `${sourceAppearance?.label ?? sourceType} file source`,
            details: remoteSourceInfo
              ? [`Source: ${remoteSourceInfo.sourceName}`, `Table: ${remoteSourceInfo.remoteTableRef}`]
              : shape.props.filename
                ? [`File: ${shape.props.filename}`]
                : undefined,
          },
        ]
      : [];

    const beginSourceChange = ({
      filename,
      name,
      fileSize = null,
      sourceName = null,
      sourceType = null,
      remoteTableRef = null,
    }: SourceChangeOptions) => {
      setSelectedColumns(new Set());
      remoteMetadataAttemptRef.current = null;

      this.editor.updateShape<DataSourceShape>({
        id: shape.id,
        type: "data-source",
        props: {
          ...(name ? { name } : {}),
          filename,
          fileSize,
          rowCount: null,
          metadata: null,
          columnStats: null,
          error: null,
          isRunning: true,
          sourceName,
          sourceType,
          remoteTableRef,
          h: calculateDataSourceHeight(null, null),
          w: calculateDataSourceWidth(null, filename),
        },
      });
    };

    useEffect(() => {
      const remoteSource = getRemoteSourceMetadata(shape);
      if (!remoteSource) {
        return;
      }

      const currentCliSource = cliSources.find((candidate) => candidate.name === remoteSource.sourceName);
      const nextProps: Partial<DataSourceShape["props"]> = {};

      if (shape.props.sourceName !== remoteSource.sourceName) {
        nextProps.sourceName = remoteSource.sourceName;
      }

      if (currentCliSource?.type && currentCliSource.type !== shape.props.sourceType) {
        nextProps.sourceType = currentCliSource.type;
      }

      if (!Object.keys(nextProps).length) {
        return;
      }

      this.editor.updateShape<DataSourceShape>({
        id: shape.id,
        type: "data-source",
        props: nextProps,
      });
    }, [cliSources, shape.id, shape.props.remoteTableRef, shape.props.sourceName, shape.props.sourceType]);

    useEffect(() => {
      const fetchAndSetMetadata = async () => {
        const currentShape = this.editor.getShape<DataSourceShape>(shape.id);
        if (!currentShape) return;

        const remoteSource = getRemoteSourceMetadata(currentShape);
        const isRemoteSource = remoteSource !== null;

        if (!isRemoteSource && currentShape.props.filename && !currentShape.props.isRunning) {
          if (currentShape.props.metadata) {
            return;
          }
          try {
            const duckDBService = DuckDBService.getInstance();
            await duckDBService.init();
            const isAvailable = await ensureBundledSourceTable({
              shapeId: shape.id,
              tableName: currentShape.props.name,
              filename: currentShape.props.filename,
            });
            if (!isAvailable) {
              throw new Error("The .kavla document does not contain this source file.");
            }

            const { schema, count } = await duckDBService.getFileMetadata(
              `KAVLA_BLOB_SOURCE_${shape.id}`,
              currentShape.props.name,
              currentShape.props.filename
            );

            this.editor.updateShape<DataSourceShape>({
              id: currentShape.id,
              type: "data-source",
              props: {
                metadata: schema,
                rowCount: count,
                isRunning: false,
                error: null,
                h: calculateDataSourceHeight(schema, count),
                w: calculateDataSourceWidth(schema, currentShape.props.filename),
              },
            });

            return;
          } catch (localErr) {
            console.error("Local .kavla source load failed", localErr);
            const reason = localErr instanceof Error ? localErr.message : String(localErr);
            this.editor.updateShape<DataSourceShape>({
              id: currentShape.id,
              type: "data-source",
              props: {
                error: `Could not load ${currentShape.props.filename}: ${reason}`,
                isRunning: false,
              },
            });
            return;
          }
        }

        if (currentShape.props.filename && !currentShape.props.metadata && remoteSource) {
          const metadataAttemptKey = `${remoteSource.sourceName}:${remoteSource.remoteTableRef}`;
          if (remoteMetadataAttemptRef.current === metadataAttemptKey) {
            return;
          }
          remoteMetadataAttemptRef.current = metadataAttemptKey;

          try {
            if (!currentShape.props.isRunning || currentShape.props.error) {
              this.editor.updateShape<DataSourceShape>({
                id: currentShape.id,
                type: "data-source",
                props: {
                  error: null,
                  isRunning: true,
                },
              });
            }
            const quotedTableName = quoteDottedIdentifier(remoteSource.remoteTableRef);
            const { columns: schema } = await getSourceSchema({ tableRef: quotedTableName });
            const { rowCount } = await getSourceStats({ tableRef: quotedTableName });

            this.editor.updateShape<DataSourceShape>({
              id: currentShape.id,
              type: "data-source",
              props: {
                metadata: schema,
                rowCount,
                isRunning: false,
                error: null,
                h: calculateDataSourceHeight(schema, rowCount),
                w: calculateDataSourceWidth(schema, currentShape.props.filename!),
              },
            });
          } catch (e: any) {
            console.error("Failed to fetch metadata on client", e);
            const latestShape = this.editor.getShape<DataSourceShape>(shape.id);
            if (!latestShape || latestShape.props.metadata) {
              return;
            }
            this.editor.updateShape<DataSourceShape>({
              id: latestShape.id,
              type: "data-source",
              props: {
                error: e.message,
                isRunning: false,
              },
            });
          }
        }
      };

      void fetchAndSetMetadata();
    }, [
      getSourceSchema,
      getSourceStats,
      shape.id,
      shape.props.filename,
      shape.props.isRunning,
      shape.props.metadata,
      shape.props.name,
      shape.props.remoteTableRef,
    ]);

    const schemaScrollArea = useTldrawScrollArea();

    const inputRef = useRef<HTMLInputElement | null>(null);

    const handleFileSelected = async (file: File) => {
      const sizeError = getLocalDataSourceSizeError(file.size);
      if (sizeError) {
        this.editor.updateShape<DataSourceShape>({
          id: shape.id,
          type: "data-source",
          props: {
            error: sizeError,
            filename: file.name,
            isRunning: false,
          },
        });
        return;
      }

      beginSourceChange({
        filename: `Saving ${file.name} locally...`,
        fileSize: file.size,
      });

      try {
        const props = await ingestLocalDataSourceFile(this.editor, shape.id, file);

        this.editor.updateShape<DataSourceShape>({
          id: shape.id,
          type: "data-source",
          props,
        });

        return;
      } catch (e: any) {
        console.error("Local load failed", e);
        this.editor.updateShape<DataSourceShape>({
          id: shape.id,
          type: "data-source",
          props: {
            error: `Local load failed: ${e.message}`,
            filename: file.name,
            isRunning: false,
          },
        });
        return;
      }
    };

    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!e.target.files?.[0]) return;
      const file = e.target.files[0];
      handleFileSelected(file);
      if (e.target) {
        e.target.value = "";
      }
    };

    const openLocalFilePicker = () => {
      inputRef.current?.click();
    };

    const handleRemoteTableSelect = (sourceName: string, table: string) => {
      const selectedCliSource = cliSources.find((source) => source.name === sourceName) ?? null;
      const displayTableName = getRemoteTableDisplayName(table);
      beginSourceChange({
        name: getUniqueName(this.editor, toValidSqlName(displayTableName), shape.id),
        filename: displayTableName,
        sourceName,
        sourceType: selectedCliSource?.type ?? null,
        remoteTableRef: table,
      });
    };

    return (
      <HTMLContainer
        id={shape.id}
        onWheel={(e) => e.stopPropagation()}
        onTouchMove={(e) => e.stopPropagation()}
        style={{
          display: "flex",
          flexDirection: "column",
          pointerEvents: "all",
          position: "relative",
          padding: 0,
          color: theme[shape.props.color].solid,
          height: "100%",
          boxSizing: "border-box",
          overflow: "visible",
        }}
      >
        <ShapeEngineTabs
          tabs={sourceTabs}
          style={{
            position: "absolute",
            top: -46,
            left: 0,
            right: 0,
          }}
        />
        <div
          style={{
            backgroundColor: "#000",
            position: "absolute",
            borderRadius: 12,
            top: 8,
            left: 8,
            bottom: 0,
            right: 0,
          }}
        />
        <div
          style={{
            border: "4px solid #000",
            borderRadius: 12,
            display: "flex",
            flexDirection: "column",
            flex: 1,
            minHeight: 0,
            backgroundColor: "#fff",
            overflow: "hidden",
            position: "relative",
            zIndex: 1,
          }}
        >
          <DataSourceHeader editor={this.editor} shape={shape} />

          <input
            type="file"
            accept=".parquet,.csv,.json"
            style={{ display: "none" }}
            ref={inputRef}
            onChange={handleUpload}
          />

          <DataSourceBody
            cancelRemoteQuery={cancelRemoteQuery}
            cliSources={cliSources}
            editor={this.editor}
            onClearSelectedColumns={() => setSelectedColumns(new Set())}
            onColumnClick={handleColumnClick}
            onLocalFilePickerOpen={openLocalFilePicker}
            onRemoteTableSelect={handleRemoteTableSelect}
            remoteSourceInfo={remoteSourceInfo}
            remoteTableDisplayName={remoteTableDisplayName}
            runRemoteQuery={runRemoteQuery}
            schemaScrollArea={schemaScrollArea}
            selectedColumns={selectedColumns}
            shape={shape}
          />

          {shape.props.error && (
            <div
              style={{
                display: "flex",
                background: "#fef2f2",
                borderTop: "4px solid #000",
              }}
            >
              <textarea
                readOnly
                onPointerDown={(e) => e.stopPropagation()}
                style={{
                  flex: 1,
                  border: "none",
                  outline: "none",
                  resize: "none",
                  padding: "8px",
                  background: "transparent",
                  color: "red",
                  fontFamily: "inherit",
                  fontSize: "12px",
                  whiteSpace: "pre-wrap",
                  boxSizing: "border-box",
                  fontWeight: "bold",
                }}
                value={shape.props.error}
                rows={(shape.props.error?.split("\n").length ?? 0) + 1}
              />
            </div>
          )}
        </div>
      </HTMLContainer>
    );
  }

  indicator(shape: DataSourceShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={12} ry={12} />;
  }

  override onResize(shape: DataSourceShape, info: TLResizeInfo<DataSourceShape>) {
    return resizeBox(shape, info);
  }

  override onBeforeUpdate(prev: DataSourceShape, next: DataSourceShape): void {
    const prevName = prev.props.name;
    const nextName = next.props.name;

    if (prevName === nextName) {
      return;
    }

    if (this.updateSourceName) {
      this.updateSourceName({ prevName, nextName });
    } else {
      console.error("updateSourceName function not initialized");
    }
  }
}
