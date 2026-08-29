import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { flexRender } from "@tanstack/react-table";
import type { VirtualItem } from "@tanstack/react-virtual";
import { Check, Copy } from "lucide-react";
import { useToasts } from "tldraw";
import { TldrawScrollAreaIndicator } from "../DataSource/TldrawScrollAreaIndicator";
import type { useTldrawScrollArea } from "../DataSource/useTldrawScrollArea";
import { getColumnTypeColor } from "../util/column-colors";
import { formatDateForDisplay, isDateLikeColumnType } from "../util/date-formatting";
import { getBriefErrorMessage } from "../util/error-message";
import { SQL_RESULT_BUTTON_CLASS } from "./sql-result-area-styles";
import type { SQLResultTable } from "./sql-result-table-features";

export type SQLResultFocusedCell = {
  rowId: string;
  colId: string;
  content: unknown;
  type: string;
  rect: DOMRect;
};

export function formatSQLResultCellValue(value: unknown, columnType: unknown) {
  if (!isDateLikeColumnType(columnType)) {
    return value;
  }

  return formatDateForDisplay(value, columnType) ?? value;
}

const SQLResultErrorPanel = ({ title, message }: { title: string; message: string }) => (
  <div
    onPointerDown={(event) => event.stopPropagation()}
    style={{
      width: "100%",
      minHeight: "100%",
      padding: 16,
      color: "#991b1b",
      backgroundColor: "#fee2e2",
      boxSizing: "border-box",
      fontSize: 12,
      fontWeight: 700,
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      lineHeight: 1.4,
      userSelect: "text",
      cursor: "text",
    }}
  >
    <div style={{ color: "#000", fontSize: 13, marginBottom: 4 }}>{title}</div>
    {message}
  </div>
);

class SQLResultTableErrorBoundary extends Component<{ children: ReactNode }, { error: unknown | null }> {
  state: { error: unknown | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    console.error("SQL result table render failed", error, errorInfo);
  }

  render() {
    if (this.state.error) {
      return <SQLResultErrorPanel title="Result table crashed" message={getBriefErrorMessage(this.state.error)} />;
    }

    return this.props.children;
  }
}

function ExpandedCellOverlay({ focusedCell, onClose }: { focusedCell: SQLResultFocusedCell; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [isCopied, setIsCopied] = useState(false);
  const { addToast } = useToasts();

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("pointerdown", handlePointerDown, { capture: true });
    return () => document.removeEventListener("pointerdown", handlePointerDown, { capture: true });
  }, [onClose]);

  const getContentText = () =>
    typeof focusedCell.content === "object" || typeof focusedCell.content === "function"
      ? JSON.stringify(focusedCell.content, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2)
      : String(focusedCell.content);

  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        top: Math.min(window.innerHeight - 200, Math.max(10, focusedCell.rect.top)),
        left: Math.min(window.innerWidth - 300, Math.max(10, focusedCell.rect.left)),
        zIndex: 99999,
        backgroundColor: "white",
        minWidth: "200px",
        maxWidth: "600px",
        maxHeight: "60vh",
        display: "flex",
        flexDirection: "column",
        border: "2px solid #000",
        borderRadius: "4px",
        boxShadow: "4px 4px 0px 0px rgba(0,0,0,1)",
        pointerEvents: "auto",
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div
        onClick={(event) => {
          event.stopPropagation();
          void navigator.clipboard.writeText(getContentText());
          setIsCopied(true);
          setTimeout(() => setIsCopied(false), 2000);
          addToast({ title: "Copied to clipboard" });
        }}
        className={SQL_RESULT_BUTTON_CLASS}
        style={{
          position: "absolute",
          top: "8px",
          right: "8px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "24px",
          width: "24px",
          padding: 0,
          zIndex: 10,
          backgroundColor: "#fff",
        }}
        title="Copy value"
      >
        {isCopied ? <Check size={14} /> : <Copy size={14} />}
      </div>
      <div
        style={{
          padding: "12px",
          paddingRight: "40px",
          fontFamily: "monospace",
          fontSize: "13px",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          overflow: "auto",
          backgroundColor: "white",
          borderRadius: "4px",
        }}
      >
        {getContentText()}
      </div>
    </div>
  );
}

interface SQLResultAreaBodyProps {
  boundaryKey: string;
  columnTotalSize: number;
  data: any[];
  dataErrorMessage: string | null;
  focusedCell: SQLResultFocusedCell | null;
  isLoadingData: boolean;
  rowTotalSize: number;
  scrollArea: ReturnType<typeof useTldrawScrollArea>;
  table: SQLResultTable;
  virtualColumns: VirtualItem[];
  virtualPaddingLeft: number | undefined;
  virtualPaddingRight: number | undefined;
  virtualRows: VirtualItem[];
  onFocusedCellChange: (cell: SQLResultFocusedCell | null) => void;
  onScroll: (scroll: { scrollTop: number; scrollLeft: number }) => void;
  setScrollContainerRef: (node: HTMLDivElement | null) => void;
}

export function SQLResultAreaBody({
  boundaryKey,
  columnTotalSize,
  data,
  dataErrorMessage,
  focusedCell,
  isLoadingData,
  rowTotalSize,
  scrollArea,
  table,
  virtualColumns,
  virtualPaddingLeft,
  virtualPaddingRight,
  virtualRows,
  onFocusedCellChange,
  onScroll,
  setScrollContainerRef,
}: SQLResultAreaBodyProps) {
  return (
    <>
      {focusedCell &&
        createPortal(
          <ExpandedCellOverlay focusedCell={focusedCell} onClose={() => onFocusedCellChange(null)} />,
          document.body
        )}

      <TldrawScrollAreaIndicator indicator={scrollArea.indicator} />

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          minWidth: 0,
          borderRight: "4px solid #000",
        }}
      >
        <div
          ref={setScrollContainerRef}
          onScroll={(event) =>
            onScroll({
              scrollTop: event.currentTarget.scrollTop,
              scrollLeft: event.currentTarget.scrollLeft,
            })
          }
          onPointerDown={scrollArea.onPointerDown}
          onPointerMove={scrollArea.onPointerMove}
          onPointerUp={scrollArea.onPointerUp}
          onPointerCancel={scrollArea.onPointerCancel}
          onWheel={scrollArea.onWheel}
          style={{ flex: 1, minHeight: 0, overflow: "auto" }}
        >
          <SQLResultTableErrorBoundary key={boundaryKey}>
            {dataErrorMessage ? (
              <SQLResultErrorPanel title="Result unavailable" message={dataErrorMessage} />
            ) : isLoadingData ? (
              <div style={{ padding: 8 }}>Loading Data...</div>
            ) : data.length === 0 ? (
              <div style={{ padding: 24, color: "#666", fontSize: 13, textAlign: "center", lineHeight: "1.5" }}>
                No rows returned
              </div>
            ) : (
              <div
                style={{
                  width: columnTotalSize,
                  display: "grid",
                  position: "relative",
                }}
              >
                <div
                  style={{
                    display: "grid",
                    position: "sticky",
                    top: 0,
                    zIndex: 1,
                    width: "100%",
                  }}
                >
                  {table.getHeaderGroups().map((headerGroup) => (
                    <div key={headerGroup.id} style={{ display: "flex", width: "100%", minWidth: "100%" }}>
                      {virtualPaddingLeft ? (
                        <div style={{ display: "flex", width: virtualPaddingLeft, flexShrink: 0 }} />
                      ) : null}
                      {virtualColumns.map((virtualColumn) => {
                        const header = headerGroup.headers[virtualColumn.index];
                        return (
                          <div
                            key={header.id}
                            style={{
                              display: "flex",
                              width: header.getSize(),
                              padding: "6px 8px",
                              fontWeight: 800,
                              textAlign: "left",
                              fontSize: 13,
                              position: "relative",
                              boxSizing: "border-box",
                              flexShrink: 0,
                              borderRight: "2px solid #000",
                              borderBottom: "2px solid #000",
                              backgroundColor: "#f9f9f9",
                            }}
                          >
                            {header.isPlaceholder ? null : (
                              <div
                                style={{
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  width: "100%",
                                }}
                                title={`${header.column.id} (${(header.column.columnDef.meta as any)?.type || "unknown type"})`}
                              >
                                <span
                                  className={`${
                                    getColumnTypeColor((header.column.columnDef.meta as any)?.type || "")
                                      ? `px-1 rounded-none text-black ${getColumnTypeColor(
                                          (header.column.columnDef.meta as any)?.type || ""
                                        )}`
                                      : ""
                                  }`}
                                >
                                  {flexRender(header.column.columnDef.header, header.getContext())}
                                </span>
                              </div>
                            )}
                            <div
                              onMouseDown={header.getResizeHandler()}
                              onTouchStart={header.getResizeHandler()}
                              className={`resizer ${header.column.getIsResizing() ? "isResizing" : ""}`}
                              style={{
                                position: "absolute",
                                right: 0,
                                top: 0,
                                height: "100%",
                                width: "5px",
                                background: header.column.getIsResizing() ? "#22c55e" : "transparent",
                                cursor: "col-resize",
                                userSelect: "none",
                                touchAction: "none",
                                zIndex: 10,
                              }}
                            />
                          </div>
                        );
                      })}
                      {virtualPaddingRight ? (
                        <div style={{ display: "flex", width: virtualPaddingRight, flexShrink: 0 }} />
                      ) : null}
                    </div>
                  ))}
                </div>

                <div
                  style={{
                    display: "grid",
                    height: `${rowTotalSize}px`,
                    width: "100%",
                    position: "relative",
                  }}
                >
                  {virtualRows.map((virtualRow) => {
                    const row = table.getRowModel().rows[virtualRow.index];
                    const visibleCells = row.getVisibleCells();

                    return (
                      <div
                        key={row.id}
                        data-index={virtualRow.index}
                        style={{
                          display: "flex",
                          position: "absolute",
                          transform: `translateY(${virtualRow.start}px)`,
                          width: "100%",
                          height: virtualRow.size,
                          top: 0,
                          left: 0,
                        }}
                      >
                        {virtualPaddingLeft ? (
                          <div style={{ display: "flex", width: virtualPaddingLeft, flexShrink: 0 }} />
                        ) : null}
                        {virtualColumns.map((virtualColumn) => {
                          const cell = visibleCells[virtualColumn.index];

                          return (
                            <div
                              key={cell.id}
                              style={{
                                display: "flex",
                                width: cell.column.getSize(),
                                padding: 0,
                                borderBottom: "2px solid #000",
                                borderRight: "2px solid #000",
                                position: "relative",
                                flexShrink: 0,
                                boxSizing: "border-box",
                              }}
                            >
                              <div
                                onClick={(event) => {
                                  event.stopPropagation();
                                  const rect = event.currentTarget.getBoundingClientRect();
                                  const columnType = (cell.column.columnDef.meta as any)?.type;
                                  onFocusedCellChange({
                                    rowId: row.id,
                                    colId: cell.column.id,
                                    content: formatSQLResultCellValue(cell.getValue(), columnType),
                                    type: "TEXT",
                                    rect,
                                  });
                                }}
                                onPointerDown={(event) => event.stopPropagation()}
                                style={{
                                  padding: "6px 8px",
                                  fontSize: 13,
                                  fontFamily: "monospace",
                                  cursor: "pointer",
                                  boxSizing: "border-box",
                                  width: "100%",
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                }}
                              >
                                {flexRender(cell.column.columnDef.cell, cell.getContext())}
                              </div>
                            </div>
                          );
                        })}
                        {virtualPaddingRight ? (
                          <div style={{ display: "flex", width: virtualPaddingRight, flexShrink: 0 }} />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </SQLResultTableErrorBoundary>
        </div>
      </div>
    </>
  );
}
