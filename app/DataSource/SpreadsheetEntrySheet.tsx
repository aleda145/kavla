import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { csvParseRows, tsvParseRows } from "d3";
import { getColumnTypeColor } from "../util/column-colors";
import type { ColumnMetadata } from "./data-source-types";
import { ColumnHoverTooltip } from "../SQLTextArea/ColumnHoverTooltip";
import type { RemoteSourceInfo } from "../SQLTextArea/remote-column-stats";
import { profileEntryColumn } from "./entry-column-stats";
import { cellLabel, columnLabel } from "./excel-import";
import { downloadSessionBlob } from "../client/local/localSession";
import { clipboardTable } from "./spreadsheet-entry";
import { CELL_WIDTH, ROW_HEADER_WIDTH } from "./useSpreadsheetViewport";
import { useTldrawScrollArea } from "./useTldrawScrollArea";
import { TldrawScrollAreaIndicator } from "./TldrawScrollAreaIndicator";
import "./excel-import.css";

type Props = {
  tableName: string;
  remoteSource: RemoteSourceInfo | null;
  metadata: ColumnMetadata[] | null;
  columnWidths?: Record<string, number>;
  onResizeColumn: (column: number, width: number) => void;
  blobId: string | null;
  draft: string[][] | null;
  readonly: boolean;
  onChange: (rows: string[][]) => void;
  dirty: boolean;
};

const emptyRows: string[][] = [];
const TABLE_ROW_HEIGHT = 35;
const TABLE_PAGE_SIZE = 1000;

function inferDraftColumnTypes(rows: string[][]): string[] {
  const types: string[] = [];
  for (let row = 1; row < rows.length; row++) {
    rows[row].forEach((cell, col) => {
      if (types[col] === "TEXT") return;
      const value = cell.trim();
      if (!value) return;
      let type = "TEXT";
      if (/^(true|false)$/i.test(value)) type = "BOOLEAN";
      else if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) type = "DOUBLE";
      else if (
        /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i.test(value) &&
        Number.isFinite(Date.parse(value))
      )
        type = "TIMESTAMP";
      types[col] = types[col] && types[col] !== type ? "TEXT" : type;
    });
  }
  return types;
}

export function SpreadsheetEntrySheet({
  blobId,
  draft,
  readonly,
  onChange,
  dirty,
  columnWidths,
  onResizeColumn,
  metadata,
  tableName,
  remoteSource,
}: Props) {
  const [loaded, setLoaded] = useState<{ id: string; rows: string[][] } | null>(null);
  const rows = draft ?? (loaded?.id === blobId ? loaded?.rows : null) ?? emptyRows;
  const ready = draft !== null || loaded?.id === blobId;
  const [error, setError] = useState("");
  const [selectedPage, setPage] = useState(0);
  const [minWidth, setWidth] = useState(6);
  const [lastBlankRow, setLastBlankRow] = useState(0);
  const dataColumns = useMemo(() => rows.reduce((max, row) => Math.max(max, row.length), 0), [rows]);
  const columnTypes = useMemo(
    () => (dirty || !metadata ? inferDraftColumnTypes(rows) : metadata.map((column) => column.type)),
    [dirty, rows, metadata]
  );
  const width = Math.max(minWidth, dataColumns + 1);
  const [hover, setHover] = useState<{ column: number; rect: DOMRect } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearHover = useCallback(() => {
    clearTimeout(hoverTimer.current);
    setHover(null);
  }, []);
  useEffect(() => {
    window.addEventListener("resize", clearHover);
    return () => {
      clearTimeout(hoverTimer.current);
      window.removeEventListener("resize", clearHover);
    };
  }, [clearHover]);
  function leaveHeader() {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(clearHover, 200);
  }
  const savedSource = !dirty && metadata ? remoteSource : null;
  const hoverType = hover ? (columnTypes[hover.column] ?? "UNKNOWN") : "";
  const draftStats = useMemo(
    () => (hover && !savedSource ? profileEntryColumn(rows, hover.column, hoverType) : null),
    [hover, rows, hoverType, savedSource]
  );
  const totalRows = Math.max(0, rows.length - 1);
  const pageCount = Math.max(1, Math.ceil(totalRows / TABLE_PAGE_SIZE));
  const pageIndex = Math.min(selectedPage, pageCount - 1);
  const offset = pageIndex * TABLE_PAGE_SIZE;
  const pageEndRow = Math.min(totalRows, offset + TABLE_PAGE_SIZE);
  // Keep room to enter the next row even when the last page is exactly full.
  const pageRows =
    pageIndex < pageCount - 1
      ? TABLE_PAGE_SIZE
      : Math.max(15, totalRows - offset + 1, Math.min(lastBlankRow - offset, TABLE_PAGE_SIZE + 1));

  const grid = useRef<HTMLDivElement>(null);
  const scrollArea = useTldrawScrollArea();
  const setGrid = useCallback(
    (element: HTMLDivElement | null) => {
      grid.current = element;
      scrollArea.ref(element);
    },
    [scrollArea.ref]
  );
  const rowVirtualizer = useVirtualizer({
    count: pageRows,
    getScrollElement: () => grid.current,
    estimateSize: () => TABLE_ROW_HEIGHT,
    paddingStart: TABLE_ROW_HEIGHT,
    scrollPaddingStart: TABLE_ROW_HEIGHT,
    overscan: 5,
  });
  const columnVirtualizer = useVirtualizer({
    count: width,
    getScrollElement: () => grid.current,
    estimateSize: (index) => columnWidths?.[index] ?? CELL_WIDTH,
    paddingStart: ROW_HEADER_WIDTH,
    scrollPaddingStart: ROW_HEADER_WIDTH,
    horizontal: true,
    overscan: 3,
  });
  useLayoutEffect(() => columnVirtualizer.measure(), [columnWidths, columnVirtualizer]);
  const visibleColumns = columnVirtualizer.getVirtualItems();
  const visibleRows = rowVirtualizer.getVirtualItems();
  const [focus, setFocus] = useState<{ row: number; col: number; select: boolean } | null>(null);
  useLayoutEffect(() => {
    if (!focus) return;
    if (focus.row > 0) rowVirtualizer.scrollToIndex(focus.row - offset - 1, { align: "auto" });
    columnVirtualizer.scrollToIndex(focus.col, { align: "auto" });
    const cell = grid.current?.querySelector<HTMLTextAreaElement>(`[data-cell="${focus.row}-${focus.col}"]`);
    if (cell) {
      cell.focus({ preventScroll: true });
      if (focus.select) cell.select();
      else cell.setSelectionRange(cell.value.length, cell.value.length);
      setFocus(null);
    }
  }, [focus, offset, rowVirtualizer, columnVirtualizer, visibleRows, visibleColumns]);

  const resizing = useRef<{ col: number; x: number; width: number; zoom: number } | null>(null);
  function resize(event: PointerEvent<HTMLDivElement>, commit: boolean) {
    const drag = resizing.current;
    if (!drag) return;
    const width = Math.max(50, Math.min(800, Math.round(drag.width + (event.clientX - drag.x) / drag.zoom)));
    columnVirtualizer.resizeItem(drag.col, width);
    if (commit) {
      resizing.current = null;
      onResizeColumn(drag.col, width);
    }
  }

  const loadBlobId = draft === null ? blobId : null;
  useEffect(() => {
    if (!loadBlobId) return;
    let active = true;
    void downloadSessionBlob(loadBlobId)
      .then((file) => file.text())
      .then((csv) => {
        if (!active) return;
        const data = csvParseRows(csv);
        setLoaded({ id: loadBlobId, rows: data });
      })
      .catch((reason: unknown) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [loadBlobId]);

  function write(row: number, col: number, block: string[][]) {
    const next = rows.slice();
    while (next.length < row + block.length) next.push([]);
    block.forEach((values, offset) => {
      const line = next[row + offset].slice();
      while (line.length < col) line.push("");
      values.forEach((value, index) => {
        line[col + index] = value;
      });
      next[row + offset] = line;
    });
    onChange(next);
    if (row > offset + TABLE_PAGE_SIZE) {
      setPage(Math.floor((row - 1) / TABLE_PAGE_SIZE));
      setFocus({ row, col, select: false });
    }
    setError("");
  }

  function navigate(event: KeyboardEvent<HTMLTextAreaElement>, row: number, col: number) {
    const key = event.key;
    if (key === "Enter" || key === "ArrowDown") {
      const down = key === "ArrowDown" || !event.shiftKey;
      row = row === 0 && down ? offset + 1 : row + (down ? 1 : -1);
    } else if (key === "ArrowUp") row--;
    else if (key === "Tab") col += event.shiftKey ? -1 : 1;
    else if (key === "ArrowRight" && event.currentTarget.selectionEnd === event.currentTarget.value.length) col++;
    else if (key === "ArrowLeft" && event.currentTarget.selectionStart === 0) col--;
    else return;
    if (row < 0 || col < 0 || (key === "Tab" && col >= width)) return;
    event.preventDefault();
    if (row > pageCount * TABLE_PAGE_SIZE + 1) return;
    if (row > 0) setPage(Math.min(pageCount - 1, Math.floor((row - 1) / TABLE_PAGE_SIZE)));
    setLastBlankRow((old) => Math.max(old, row));
    setWidth((old) => Math.max(old, col + 1));
    setFocus({ row, col, select: true });
  }

  function changePage(index: number) {
    setFocus(null);
    if (grid.current) grid.current.scrollTop = 0;
    setPage(Math.max(0, Math.min(index, pageCount - 1)));
  }

  function cell(row: number, col: number) {
    const type = row === 0 ? columnTypes[col] : undefined;
    const typeLabel = type ? `${dirty || !metadata ? "Estimated type" : "Type"}: ${type}` : undefined;
    return (
      <textarea
        rows={1}
        data-cell={row + "-" + col}
        aria-description={typeLabel}
        aria-label={row === 0 ? `Column name ${cellLabel(row, col)}` : cellLabel(row, col)}
        placeholder={row === 0 ? `Column ${columnLabel(col)}` : undefined}
        value={rows[row]?.[col] ?? ""}
        disabled={!ready || readonly}
        onChange={(event) => write(row, col, [[event.target.value]])}
        onKeyDown={(event) => navigate(event, row, col)}
        onPaste={(event) => {
          const value = event.clipboardData.getData("text/plain");
          const block = clipboardTable(value, event.clipboardData.getData("text/html"));
          if (block || /[\r\n]/.test(value)) {
            event.preventDefault();
            write(row, col, block ?? tsvParseRows(value));
          }
        }}
      />
    );
  }

  return (
    <div
      className="entry-sheet"
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape" || event.target instanceof HTMLTextAreaElement) clearHover();
        event.stopPropagation();
      }}
      onPaste={(event) => event.stopPropagation()}
    >
      <TldrawScrollAreaIndicator indicator={scrollArea.indicator} />
      <div
        ref={setGrid}
        className="entry-grid"
        aria-label="Spreadsheet cells"
        onScroll={clearHover}
        onPointerDownCapture={clearHover}
        onPointerDown={scrollArea.onPointerDown}
        onPointerMove={scrollArea.onPointerMove}
        onPointerUp={scrollArea.onPointerUp}
        onPointerCancel={scrollArea.onPointerCancel}
        onWheel={scrollArea.onWheel}
      >
        <div
          style={{
            position: "relative",
            width: columnVirtualizer.getTotalSize(),
            height: rowVirtualizer.getTotalSize(),
          }}
        >
          <div className="entry-headers" style={{ height: TABLE_ROW_HEIGHT }}>
            <div className="entry-row-number" style={{ width: ROW_HEADER_WIDTH }}>
              1
            </div>
            {visibleColumns.map((col) => (
              <div
                key={col.index}
                className="entry-cell"
                style={{ left: col.start, width: col.size }}
                onMouseEnter={(event) => {
                  clearHover();
                  if (!ready || resizing.current || (!rows[0]?.[col.index]?.trim() && !columnTypes[col.index])) return;
                  const header = event.currentTarget;
                  hoverTimer.current = setTimeout(() => {
                    if (header.isConnected) setHover({ column: col.index, rect: header.getBoundingClientRect() });
                  }, 200);
                }}
                onMouseLeave={leaveHeader}
              >
                {columnTypes[col.index] && (
                  <span
                    aria-hidden="true"
                    className={`entry-type-highlight ${getColumnTypeColor(columnTypes[col.index])}`}
                  >
                    {rows[0]?.[col.index] || `Column ${columnLabel(col.index)}`}
                  </span>
                )}
                {cell(0, col.index)}
                {!readonly && (
                  <div
                    className="entry-resizer"
                    title={`Resize column ${columnLabel(col.index)}`}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      event.preventDefault();
                      const header = event.currentTarget.parentElement!;
                      resizing.current = {
                        col: col.index,
                        x: event.clientX,
                        width: col.size,
                        zoom: header.getBoundingClientRect().width / header.offsetWidth,
                      };
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }}
                    onPointerMove={(event) => resize(event, false)}
                    onPointerUp={(event) => resize(event, true)}
                    onLostPointerCapture={() => {
                      const drag = resizing.current;
                      if (drag) columnVirtualizer.resizeItem(drag.col, drag.width);
                      resizing.current = null;
                    }}
                  />
                )}
              </div>
            ))}
          </div>
          {visibleRows.map((item) => {
            const row = offset + item.index + 1;
            return (
              <div key={row} className="entry-row" style={{ top: item.start, height: item.size }}>
                <div className="entry-row-number" style={{ width: ROW_HEADER_WIDTH }}>
                  {row + 1}
                </div>
                {visibleColumns.map((col) => (
                  <div key={col.index} className="entry-cell" style={{ left: col.start, width: col.size }}>
                    {cell(row, col.index)}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
      {hover &&
        ready &&
        createPortal(
          <div
            onMouseEnter={() => clearTimeout(hoverTimer.current)}
            onMouseLeave={leaveHeader}
            style={{
              position: "fixed",
              zIndex: 999999,
              pointerEvents: "auto",
              left: Math.max(4, Math.min(hover.rect.left, window.innerWidth - 284)),
              ...(hover.rect.bottom + 260 <= window.innerHeight || hover.rect.top < window.innerHeight / 2
                ? { top: hover.rect.bottom + 4, maxHeight: window.innerHeight - hover.rect.bottom - 8 }
                : { bottom: window.innerHeight - hover.rect.top + 4, maxHeight: hover.rect.top - 8 }),
              overflowY: "auto",
            }}
          >
            <ColumnHoverTooltip
              key={`${savedSource?.fullTableRef ?? "draft"}-${hover.column}`}
              tableName={tableName}
              columnName={
                (savedSource ? metadata?.[hover.column]?.name : rows[0]?.[hover.column]) ||
                `Column ${columnLabel(hover.column)}`
              }
              type={hoverType}
              remoteSource={savedSource}
              precomputedStats={draftStats}
            />
          </div>,
          document.body
        )}
      {error && (
        <div role="alert" className="excel-error">
          {error}
        </div>
      )}
      <footer className="entry-footer">
        <span>
          {ready ? `${totalRows.toLocaleString()} rows` : "Loading cells…"}
          {totalRows > 0 && `, showing ${(offset + 1).toLocaleString()}–${pageEndRow.toLocaleString()}`}
        </span>
        {pageCount > 1 && (
          <nav aria-label="Sheet pages">
            <button
              type="button"
              title="Previous page"
              aria-label="Previous page"
              disabled={pageIndex === 0}
              onClick={() => changePage(pageIndex - 1)}
            >
              <ChevronLeft size={14} aria-hidden="true" />
              <span className="kavla-control-label">Prev</span>
            </button>
            <span>
              Page {(pageIndex + 1).toLocaleString()} / {pageCount.toLocaleString()}
            </span>
            <button
              type="button"
              title="Next page"
              aria-label="Next page"
              disabled={pageIndex === pageCount - 1}
              onClick={() => changePage(pageIndex + 1)}
            >
              <ChevronRight size={14} aria-hidden="true" />
              <span className="kavla-control-label">Next</span>
            </button>
          </nav>
        )}
      </footer>
    </div>
  );
}
