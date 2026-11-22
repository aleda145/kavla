import { useEffect, useState, type KeyboardEvent } from "react";
import { csvParseRows, tsvParseRows } from "d3";
import { cellLabel, columnLabel } from "./excel-import";
import { downloadSessionBlob } from "../client/local/localSession";
import { clipboardTable } from "./spreadsheet-entry";
import { useSpreadsheetViewport, CELL_HEIGHT, CELL_WIDTH, ROW_HEADER_WIDTH } from "./useSpreadsheetViewport";
import "./excel-import.css";

type Props = {
  blobId: string | null;
  draft: string[][] | null;
  readonly: boolean;
  onChange: (rows: string[][]) => void;
  onSave: (rows: string[][]) => Promise<void>;
};

export function SpreadsheetEntrySheet({ blobId, draft, readonly, onChange, onSave }: Props) {
  const [loaded, setLoaded] = useState<{ id: string; rows: string[][] } | null>(null);
  const rows = draft ?? (loaded?.id === blobId ? loaded?.rows : null) ?? [];
  const [minWidth, setWidth] = useState(6);
  const [minHeight, setHeight] = useState(16);
  const width = Math.max(
    minWidth,
    rows.reduce((max, row) => Math.max(max, row.length + 1), 0)
  );
  const height = Math.max(minHeight, rows.length + 1);
  const ready = !!draft || loaded?.id === blobId;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const { viewport, visibleRows, visibleColumns, onScroll } = useSpreadsheetViewport(height, width);

  useEffect(() => {
    const grid = viewport.current!;
    const scrollCells = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) event.stopPropagation();
    };
    grid.addEventListener("wheel", scrollCells, { passive: true });
    return () => grid.removeEventListener("wheel", scrollCells);
  }, [viewport]);

  useEffect(() => {
    if (!blobId) return;
    let active = true;
    void downloadSessionBlob(blobId)
      .then((file) => file.text())
      .then((csv) => {
        if (!active) return;
        const data = csvParseRows(csv);
        setLoaded({ id: blobId, rows: data });
      })
      .catch((reason: unknown) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [blobId]);

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
    setHeight((old) => Math.max(old, row + block.length + 1));
    setWidth((old) => Math.max(old, col + block.reduce((max, values) => Math.max(max, values.length), 0) + 1));
    setError("");
  }

  function navigate(event: KeyboardEvent<HTMLTextAreaElement>, row: number, col: number) {
    const key = event.key;
    if (key === "Enter" || key === "ArrowDown") row += event.shiftKey ? -1 : 1;
    else if (key === "ArrowUp") row--;
    else if (key === "Tab") col += event.shiftKey ? -1 : 1;
    else if (key === "ArrowRight" && event.currentTarget.selectionEnd === event.currentTarget.value.length) col++;
    else if (key === "ArrowLeft" && event.currentTarget.selectionStart === 0) col--;
    else return;
    if (row < 0 || col < 0 || (key === "Tab" && col >= width)) return;
    event.preventDefault();
    const grid = viewport.current!;
    setHeight((old) => Math.max(old, row + 1));
    setWidth((old) => Math.max(old, col + 1));
    const top = row * CELL_HEIGHT,
      left = col * CELL_WIDTH;
    grid.scrollTop = Math.max(top + 2 * CELL_HEIGHT - grid.clientHeight, Math.min(top, grid.scrollTop));
    grid.scrollLeft = Math.max(
      left + CELL_WIDTH + ROW_HEADER_WIDTH - grid.clientWidth,
      Math.min(left, grid.scrollLeft)
    );
    requestAnimationFrame(() => {
      const input = grid.querySelector<HTMLTextAreaElement>(`[data-cell="${row}-${col}"]`);
      input?.focus();
      input?.select();
    });
  }

  async function save() {
    if (!ready || saving || readonly) return;
    setError("");
    setSaving(true);
    try {
      await onSave(rows);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="entry-sheet"
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onPaste={(event) => event.stopPropagation()}
    >
      <div ref={viewport} className="excel-grid entry-grid" onScroll={onScroll} aria-label="Spreadsheet cells">
        <div
          style={{
            position: "relative",
            width: ROW_HEADER_WIDTH + width * CELL_WIDTH,
            height: (height + 1) * CELL_HEIGHT,
          }}
        >
          <div className="excel-column-headers" style={{ height: CELL_HEIGHT }}>
            <div className="excel-corner" style={{ width: ROW_HEADER_WIDTH }}>
              #
            </div>
            {visibleColumns.map((col) => (
              <div
                key={col}
                className="excel-column-letter"
                style={{ left: ROW_HEADER_WIDTH + col * CELL_WIDTH, width: CELL_WIDTH }}
              >
                {columnLabel(col)}
              </div>
            ))}
          </div>
          {visibleRows.map((row) => (
            <div key={row} className="excel-grid-row" style={{ top: (row + 1) * CELL_HEIGHT, height: CELL_HEIGHT }}>
              <div className="excel-row-number" style={{ width: ROW_HEADER_WIDTH }}>
                {row + 1}
              </div>
              {visibleColumns.map((col) => (
                <textarea
                  key={col}
                  rows={1}
                  data-cell={row + "-" + col}
                  aria-label={cellLabel(row, col)}
                  className={row === 0 ? "excel-cell excel-header-cell" : "excel-cell"}
                  style={{ left: ROW_HEADER_WIDTH + col * CELL_WIDTH, width: CELL_WIDTH }}
                  value={rows[row]?.[col] ?? ""}
                  disabled={!ready || saving || readonly}
                  placeholder={row === 0 ? "Column name" : ""}
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
              ))}
            </div>
          ))}
        </div>
      </div>
      {error && (
        <div role="alert" className="excel-error">
          {error}
        </div>
      )}
      <footer className="excel-footer">
        <span>
          {!ready ? "Loading cells…" : draft ? "Row 1 names the columns. Save to query your edits." : "Saved"}
        </span>
        <button type="button" disabled={!draft || !ready || saving || readonly} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </button>
      </footer>
    </div>
  );
}
