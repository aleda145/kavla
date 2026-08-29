import {
  HTMLContainer,
  Rectangle2d,
  ShapeUtil,
  TLResizeInfo,
  getDefaultColorTheme,
  resizeBox,
  TLShapeId,
  useToasts,
  useValue,
} from "tldraw";
import { SQLResultTableProps } from "./sql-result-table-props";
import { SQLResultTableMigrations } from "./sql-result-table-migrations";
import { SQLResultTableShape } from "./sql-result-table-types";
import { useMemo, useRef, useEffect, useState, useCallback } from "react";
import { SQLTextAreaShape } from "../SQLTextArea/sql-text-area-types";
import { useTable } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import throttle from "lodash.throttle";
import { DuckDBService } from "@/duckdb-service";
import { useTldrawScrollArea } from "../DataSource/useTldrawScrollArea";
import { downloadTable, type TableDownloadFormat, type TableDownloadSource } from "../util/downloadTable";
import { formatSQLResultCellValue, SQLResultAreaBody, type SQLResultFocusedCell } from "./SQLResultAreaBody";
import { SQLResultAreaActionBar } from "./SQLResultAreaActionBar";
import { SQLResultAreaFooter } from "./SQLResultAreaFooter";
import { SQLResultAreaHeader } from "./SQLResultAreaHeader";
import { useData } from "../client/useLocalServer";
import { MissingQueryResultError } from "../client/localServer/types";
import { getOrderedDependenciesForSQL } from "../SQLTextArea/sqlDependencies";
import { describeQueryExecution } from "../SQLTextArea/walkSQLDag";
import { SQL_RESULT_TABLE_FEATURES, type SQLResultRow } from "./sql-result-table-features";
import { quoteIdentifier } from "../src/duckdb/sql";
import { ensureLocalQueryView } from "../SQLTextArea/sqlDagDependencies";
import { getRestoredRemoteQueryMetadata, restoreRemoteQueryView } from "../SQLTextArea/restoreRemoteQueryView";
import { getBriefErrorMessage } from "../util/error-message";
import { confirmLargeTableDownload, estimateTableDownloadBytesFromRows } from "../util/largeTableDownload";

const TABLE_ROW_HEIGHT = 35;
const TABLE_PAGE_SIZE = 1000;

function startPreparedDownload(download: { downloadUrl: string; fileName: string }): void {
  const anchor = document.createElement("a");
  anchor.href = download.downloadUrl;
  anchor.download = download.fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

export class SQLResultTableUtil extends ShapeUtil<SQLResultTableShape> {
  static override type = "sql-result-table" as const;
  static override props = SQLResultTableProps;
  static override migrations = SQLResultTableMigrations;

  getDefaultProps(): SQLResultTableShape["props"] {
    return {
      sourceShapeId: null,
      w: 400,
      h: 300,
      columnSizing: {},
    };
  }

  getGeometry(shape: SQLResultTableShape) {
    return new Rectangle2d({
      width: shape.props.w,
      height: shape.props.h,
      isFilled: true,
    });
  }

  component(shape: SQLResultTableShape) {
    const theme = getDefaultColorTheme({
      isDarkMode: this.editor.user.getIsDarkMode(),
    });
    const { sourceShapeId, scrollTop, scrollLeft, columnSizing } = shape.props;
    const { addToast } = useToasts();
    const { getQueryResultPage, prepareQueryResultDownload, runRemoteQuery } = useData();
    const [isCopied, setIsCopied] = useState(false);

    const sourceShape = useValue(
      "source shape",
      () => this.editor.getShape(sourceShapeId as TLShapeId) as SQLTextAreaShape | undefined,
      [sourceShapeId]
    );
    const isCLIResult = sourceShape
      ? describeQueryExecution(getOrderedDependenciesForSQL(this.editor, sourceShape.props.text).orderedDependencies)
          .isRemoteExecution
      : false;

    const scrollArea = useTldrawScrollArea();
    const parentRef = useRef<HTMLDivElement>(null);

    const [pageData, setPageData] = useState<any[]>([]);
    const [columns, setColumns] = useState<any[]>([]);
    const [totalRows, setTotalRows] = useState<number>(0);
    const [pageIndex, setPageIndex] = useState(0);
    const [isLoadingData, setIsLoadingData] = useState(false);
    const [dataError, setDataError] = useState<string | null>(null);

    useEffect(() => {
      setPageIndex(0);
      if (parentRef.current) {
        parentRef.current.scrollTop = 0;
      }
    }, [sourceShape?.id, sourceShape?.props.lastRunStats?.executionTime]);

    const fetchDataPage = useCallback(async () => {
      setDataError(null);
      setIsLoadingData(true);

      if (!sourceShape) {
        setPageData([]);
        setColumns([]);
        setTotalRows(0);
        setIsLoadingData(false);
        return;
      }

      try {
        if (isCLIResult) {
          const restoredMetadata = getRestoredRemoteQueryMetadata(sourceShape.id);
          const outputSchema = restoredMetadata?.schema ?? sourceShape.props.outputSchema ?? [];
          const pageRequest = {
            shapeId: sourceShape.id,
            offset: pageIndex * TABLE_PAGE_SIZE,
            limit: TABLE_PAGE_SIZE,
          };
          let page;
          try {
            page = await getQueryResultPage(pageRequest);
          } catch (error) {
            if (!(error instanceof MissingQueryResultError)) throw error;
            await restoreRemoteQueryView(this.editor, sourceShape, runRemoteQuery);
            page = await getQueryResultPage(pageRequest);
          }
          setColumns(
            outputSchema.map((column) => ({
              accessorKey: column.name,
              header: column.name,
              meta: { type: column.type },
              cell: (info: any) => String(formatSQLResultCellValue(info.getValue(), column.type) ?? ""),
            }))
          );
          setPageData(page.rows);
          setTotalRows(restoredMetadata?.rowCount ?? sourceShape.props.lastRunStats?.rowCount ?? 0);
          return;
        }

        const duckDBService = DuckDBService.getInstance();
        await duckDBService.init();
        if (!duckDBService.isTableLoaded(sourceShape.props.name)) {
          await ensureLocalQueryView(this.editor, sourceShape);
        }

        if (duckDBService.isTableLoaded(sourceShape.props.name)) {
          const db = await duckDBService.getDb();
          if (!db) return;
          const conn = await db.connect();
          try {
            const outputSchema = sourceShape.props.outputSchema;
            const knownRowCount = sourceShape.props.lastRunStats?.rowCount;
            const dataRes = await conn.query(
              `SELECT * FROM ${quoteIdentifier(sourceShape.props.name)} LIMIT ${TABLE_PAGE_SIZE} OFFSET ${
                pageIndex * TABLE_PAGE_SIZE
              }`
            );
            const schemaRes = outputSchema
              ? null
              : await conn.query(`DESCRIBE SELECT * FROM ${quoteIdentifier(sourceShape.props.name)}`);
            const countRes =
              typeof knownRowCount === "number"
                ? null
                : await conn.query(`SELECT COUNT(*) as count FROM ${quoteIdentifier(sourceShape.props.name)}`);

            const schema =
              outputSchema ??
              schemaRes!.toArray().map((r: any) => {
                const row = r.toJSON();
                return { name: row.column_name, type: row.column_type };
              });
            const rows = dataRes.toArray().map((r: any) => r.toJSON());
            const count =
              typeof knownRowCount === "number" ? knownRowCount : Number(countRes!.toArray()[0].toJSON().count);

            setColumns(
              schema.map((s: any) => ({
                accessorKey: s.name,
                header: s.name,
                meta: { type: s.type },
                cell: (info: any) => String(formatSQLResultCellValue(info.getValue(), s.type) ?? ""),
              }))
            );
            setPageData(rows);
            setTotalRows(count);
          } finally {
            await conn.close();
          }
        } else {
          setPageData([]);
          setColumns([]);
          setTotalRows(0);
        }
      } catch (e: any) {
        if (e instanceof MissingQueryResultError) {
          setPageData([]);
        } else {
          console.error("Failed to fetch result data", e);
        }
        const errorMessage = getBriefErrorMessage(e, "Could not load this result.");
        setDataError(errorMessage);
      } finally {
        setIsLoadingData(false);
      }
    }, [
      sourceShape?.props.name,
      sourceShape?.props.outputSchema,
      sourceShape?.props.lastRunStats?.rowCount,
      sourceShape?.props.lastRunStats?.runnerName,
      sourceShape?.id,
      pageIndex,
      getQueryResultPage,
      runRemoteQuery,
      isCLIResult,
    ]);

    useEffect(() => {
      fetchDataPage();
    }, [fetchDataPage, sourceShape?.props.lastRunStats]);

    const data = pageData;
    const pageCount = Math.max(1, Math.ceil(totalRows / TABLE_PAGE_SIZE));
    const pageStartRow = totalRows === 0 ? 0 : pageIndex * TABLE_PAGE_SIZE + 1;
    const pageEndRow = Math.min(totalRows, (pageIndex + 1) * TABLE_PAGE_SIZE);

    useEffect(() => {
      if (parentRef.current) {
        parentRef.current.scrollTop = 0;
      }
    }, [pageIndex]);

    const [focusedCell, setFocusedCell] = useState<SQLResultFocusedCell | null>(null);

    const SIDEBAR_WIDTH = 90;
    const SCROLLBAR_WIDTH = 16;
    const BORDER_WIDTHS = 8;
    const availableTableWidth = Math.max(0, shape.props.w - SIDEBAR_WIDTH - BORDER_WIDTHS - SCROLLBAR_WIDTH);

    const explicitlySizedWidth = useMemo(
      () =>
        columns.reduce((acc, col) => {
          const colId = (col as any).accessorKey || (col as any).header;
          return acc + (columnSizing?.[colId] || 0);
        }, 0),
      [columns, columnSizing]
    );

    const unresizedColumns = useMemo(
      () =>
        columns.filter((col) => {
          const colId = (col as any).accessorKey || (col as any).header;
          return !columnSizing?.[colId];
        }),
      [columns, columnSizing]
    );

    const tableColumns = useMemo(() => {
      if (unresizedColumns.length === 0) {
        return columns;
      }

      const CHAR_WIDTH_ESTIMATE = 8;
      const PADDING_AND_ICON_WIDTH = 42;
      const MAX_BASE_WIDTH = 150;
      const MAX_AUTO_WIDTH = 400;
      const ABSOLUTE_MIN_WIDTH = 50;

      const idealBaseWidths: Record<string, number> = {};
      const trueMaxContentWidths: Record<string, number> = {};
      let sumBaseWidths = 0;

      unresizedColumns.forEach((col) => {
        const colId = (col as any).accessorKey || (col as any).header;
        let maxLen = String(colId).length;

        const rowsToScan = Math.min(data.length, 500);
        for (let i = 0; i < rowsToScan; i++) {
          const val = data[i][colId];
          const len = val === null || val === undefined ? 4 /* "null" */ : String(val).length;
          if (len > maxLen) {
            maxLen = len;
          }
        }

        const calculatedWidth = maxLen * CHAR_WIDTH_ESTIMATE + PADDING_AND_ICON_WIDTH;

        // Keep the initial table compact, but remember enough width to fit the
        // sampled content if the shape has room.
        idealBaseWidths[colId] = Math.max(ABSOLUTE_MIN_WIDTH, Math.min(MAX_BASE_WIDTH, calculatedWidth));
        trueMaxContentWidths[colId] = Math.max(idealBaseWidths[colId], Math.min(MAX_AUTO_WIDTH, calculatedWidth));

        sumBaseWidths += idealBaseWidths[colId];
      });

      const finalWidths: Record<string, number> = { ...idealBaseWidths };
      const totalRequiredBaseWidth = sumBaseWidths + explicitlySizedWidth;

      let remainingToAllocate = Math.max(0, availableTableWidth - totalRequiredBaseWidth);

      // Fill sampled content widths before distributing any remaining space.
      let columnsNeedingWidth = unresizedColumns.filter((col) => {
        const colId = (col as any).accessorKey || (col as any).header;
        return finalWidths[colId] < trueMaxContentWidths[colId];
      });

      while (remainingToAllocate > 0 && columnsNeedingWidth.length > 0) {
        const share = remainingToAllocate / columnsNeedingWidth.length;
        let widthAddedThisRound = false;

        for (const col of columnsNeedingWidth) {
          if (remainingToAllocate <= 0) break;

          const colId = (col as any).accessorKey || (col as any).header;
          const current = finalWidths[colId];
          const max = trueMaxContentWidths[colId];
          const deficit = max - current;

          const amountToAdd = Math.min(share, deficit, remainingToAllocate);
          if (amountToAdd > 0) {
            finalWidths[colId] += amountToAdd;
            remainingToAllocate -= amountToAdd;
            widthAddedThisRound = true;
          }
        }

        if (!widthAddedThisRound) break;

        columnsNeedingWidth = columnsNeedingWidth.filter((col) => {
          const colId = (col as any).accessorKey || (col as any).header;
          return finalWidths[colId] < trueMaxContentWidths[colId];
        });
      }

      if (remainingToAllocate > 1) {
        const extraShare = remainingToAllocate / unresizedColumns.length;
        unresizedColumns.forEach((col) => {
          const colId = (col as any).accessorKey || (col as any).header;
          finalWidths[colId] += extraShare;
        });
      }

      return columns.map((col) => {
        const colId = (col as any).accessorKey || (col as any).header;
        if (columnSizing?.[colId]) {
          return col;
        }

        const finalSize = finalWidths[colId];

        return {
          ...(col as any),
          size: finalSize,
          minSize: ABSOLUTE_MIN_WIDTH,
          maxSize: Math.max(800, finalSize),
        };
      });
    }, [columns, data, availableTableWidth, explicitlySizedWidth, columnSizing, unresizedColumns, shape.props.w]);

    const table = useTable<typeof SQL_RESULT_TABLE_FEATURES, SQLResultRow>({
      features: SQL_RESULT_TABLE_FEATURES,
      data,
      columns: tableColumns,
      enableColumnResizing: true,
      columnResizeMode: "onChange",
      defaultColumn: {
        size: 150,
        minSize: 50,
        maxSize: 800,
      },
      onColumnSizingChange: (updater) => {
        const next = typeof updater === "function" ? updater(shape.props.columnSizing ?? {}) : updater;
        this.editor.updateShape({
          id: shape.id,
          type: "sql-result-table",
          props: { columnSizing: next },
        });
      },
      state: {
        columnSizing: columnSizing ?? {},
      },
    });

    const setParentRef = useCallback(
      (node: HTMLDivElement | null) => {
        parentRef.current = node;
        scrollArea.ref(node);
      },
      [scrollArea.ref]
    );

    const rowVirtualizer = useVirtualizer({
      count: table.getRowModel().rows.length,
      getScrollElement: () => parentRef.current,
      estimateSize: () => TABLE_ROW_HEIGHT,
      overscan: 5,
    });

    const columnVirtualizer = useVirtualizer({
      count: table.getVisibleLeafColumns().length,
      getScrollElement: () => parentRef.current,
      estimateSize: (index) => table.getVisibleLeafColumns()[index].getSize(),
      horizontal: true,
      overscan: 3,
    });

    const isScrolling = useRef(false);
    const isRemoteUpdate = useRef(false);
    const scrollTimeout = useRef<any>(null);

    const onScroll = useMemo(
      () =>
        throttle((scroll: { scrollTop: number; scrollLeft: number }) => {
          if (isRemoteUpdate.current) {
            isRemoteUpdate.current = false;
            return;
          }

          if (isScrolling.current === false) {
            setFocusedCell(null);
          }

          setFocusedCell(null);

          isScrolling.current = true;
          if (scrollTimeout.current) clearTimeout(scrollTimeout.current);
          scrollTimeout.current = setTimeout(() => {
            isScrolling.current = false;
          }, 150);

          this.editor.updateShape({
            id: shape.id,
            type: "sql-result-table",
            props: { scrollTop: scroll.scrollTop, scrollLeft: scroll.scrollLeft },
          });
        }, 30),
      [shape.id]
    );

    useEffect(() => {
      if (parentRef.current && !isScrolling.current) {
        // Ignore the scroll event caused by applying another client's position.
        isRemoteUpdate.current = true;

        if (typeof scrollTop === "number" && Math.abs(parentRef.current.scrollTop - scrollTop) > 5) {
          parentRef.current.scrollTop = scrollTop;
        }
        if (typeof scrollLeft === "number" && Math.abs(parentRef.current.scrollLeft - scrollLeft) > 5) {
          parentRef.current.scrollLeft = scrollLeft;
        }

        // Reset even when assigning the same value produces no scroll event.
        setTimeout(() => {
          isRemoteUpdate.current = false;
        }, 50);
      }
    }, [scrollTop, scrollLeft, rowVirtualizer.getTotalSize(), columnVirtualizer.getTotalSize()]);

    const handleCopyTSV = async () => {
      try {
        const columnIds = columns.map((column: any) => column.accessorKey || column.header).filter(Boolean);
        const header = columnIds.join("\t");
        const body = pageData
          .map((row) =>
            columnIds
              .map((columnId) => {
                const value = row[columnId];
                if (value === null || value === undefined) return "";
                if (typeof value === "object") return JSON.stringify(value);
                return String(value);
              })
              .join("\t")
          )
          .join("\n");
        const tsvContent = body ? `${header}\n${body}` : header;

        await navigator.clipboard.writeText(tsvContent);
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), 2000);
      } catch (e) {
        console.error("Copy failed", e);
      }
    };

    const handleDownload = async (format: TableDownloadFormat) => {
      const outputBaseName = sourceShape?.props.name || "result";

      if (!sourceShape) return;

      const columnNames = columns.map((column: any) => column.accessorKey || column.header).filter(Boolean);
      const estimatedBytes = estimateTableDownloadBytesFromRows(pageData, columnNames, totalRows);
      if (!confirmLargeTableDownload({ bytes: estimatedBytes, format, subject: "This result" })) {
        return;
      }

      if (isCLIResult) {
        const prepareDownload = () =>
          prepareQueryResultDownload({
            shapeId: sourceShape.id,
            format,
            fileName: outputBaseName,
          });

        try {
          let download;
          try {
            download = await prepareDownload();
          } catch (error) {
            if (!(error instanceof MissingQueryResultError)) throw error;
            await restoreRemoteQueryView(this.editor, sourceShape, runRemoteQuery);
            download = await prepareDownload();
          }
          startPreparedDownload(download);
        } catch (error) {
          console.error(`${format === "csv" ? "CSV" : "Parquet"} download failed`, error);
          addToast({
            title: "Download failed",
            description: error instanceof Error ? error.message : String(error),
            severity: "error",
          });
        }
        return;
      }

      const downloadSource: TableDownloadSource = {
        kind: "local",
        filename: `${sourceShape.props.name}.query`,
        loadOriginalFile: async () => {
          throw new Error("Query results are not stored in the .kavla file.");
        },
        recoverTable: async () => {
          await ensureLocalQueryView(this.editor, sourceShape);
        },
      };

      try {
        await downloadTable({
          format,
          outputBaseName,
          tableName: sourceShape?.props.name || outputBaseName,
          source: downloadSource,
          onConversionTooLarge: (description) => {
            addToast({
              title: "File Too Large",
              description,
              icon: "cross-2",
            });
          },
        });
      } catch (error) {
        console.error(`${format === "csv" ? "CSV" : "Parquet"} download failed`, error);
        addToast({
          title: "Download failed",
          description: error instanceof Error ? error.message : String(error),
          severity: "error",
        });
      }
    };

    const virtualRows = rowVirtualizer.getVirtualItems();
    const virtualColumns = columnVirtualizer.getVirtualItems();

    let virtualPaddingLeft: number | undefined;
    let virtualPaddingRight: number | undefined;

    if (columnVirtualizer && virtualColumns.length) {
      virtualPaddingLeft = virtualColumns[0]?.start ?? 0;
      virtualPaddingRight = columnVirtualizer.getTotalSize() - (virtualColumns[virtualColumns.length - 1]?.end ?? 0);
    }

    const dataErrorMessage = dataError;

    return (
      <HTMLContainer
        id={shape.id}
        onWheel={(e) => e.stopPropagation()}
        onTouchMove={(e) => e.stopPropagation()}
        style={{
          border: "4px solid #000",
          borderRadius: 12,
          display: "flex",
          flexDirection: "column", // Column layout mostly
          pointerEvents: "all",
          padding: 0,
          backgroundColor: "#fff",
          color: theme.black.solid,
          height: "100%",
          boxSizing: "border-box",
          overflow: "hidden",
          fontFamily: "Inter, sans-serif",
        }}
      >
        <SQLResultAreaHeader resultName={sourceShape?.props.name || "Result"} />

        <div style={{ display: "flex", flex: 1, flexDirection: "row", minHeight: 0 }}>
          <SQLResultAreaBody
            boundaryKey={`${shape.id}:${sourceShape?.props.lastRunStats?.rowCount ?? "no-run"}:${sourceShape?.props.lastRunStats?.executionTime ?? "no-time"}:local`}
            columnTotalSize={columnVirtualizer.getTotalSize()}
            data={data}
            dataErrorMessage={dataErrorMessage}
            focusedCell={focusedCell}
            isLoadingData={isLoadingData}
            rowTotalSize={rowVirtualizer.getTotalSize()}
            scrollArea={scrollArea}
            table={table}
            virtualColumns={virtualColumns}
            virtualPaddingLeft={virtualPaddingLeft}
            virtualPaddingRight={virtualPaddingRight}
            virtualRows={virtualRows}
            onFocusedCellChange={setFocusedCell}
            onScroll={onScroll}
            setScrollContainerRef={setParentRef}
          />

          <SQLResultAreaActionBar
            isCopied={isCopied}
            isDisabled={false}
            onCopy={handleCopyTSV}
            onDownload={handleDownload}
          />
        </div>
        <SQLResultAreaFooter
          isLoading={isLoadingData}
          pageCount={pageCount}
          pageEndRow={pageEndRow}
          pageIndex={pageIndex}
          pageSize={TABLE_PAGE_SIZE}
          pageStartRow={pageStartRow}
          totalRows={totalRows}
          onNextPage={() => setPageIndex((page) => Math.min(pageCount - 1, page + 1))}
          onPreviousPage={() => setPageIndex((page) => Math.max(0, page - 1))}
        />
      </HTMLContainer>
    );
  }

  indicator(shape: SQLResultTableShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={12} ry={12} />;
  }

  override onResize(shape: SQLResultTableShape, info: TLResizeInfo<SQLResultTableShape>) {
    return resizeBox(shape, info);
  }
}
