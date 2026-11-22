import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { csvFormatRows, csvParseRows, tsvParseRows } from "d3";
import { FileSpreadsheet } from "lucide-react";
import { cellLabel, columnLabel } from "./excel-import";
import { downloadSessionBlob } from "../client/local/localSession";
import { useSpreadsheetViewport, CELL_HEIGHT, CELL_WIDTH, ROW_HEADER_WIDTH } from "./useSpreadsheetViewport";
import "./excel-import.css";

export const ENTRY_MIME = "application/vnd.kavla.entry+csv";

type Props = {
  blobId: string | null;
  onSave: (file: File) => Promise<void>;
  onClose: () => void;
};

export function SpreadsheetEntryDialog({ blobId, onSave, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [rows, setRows] = useState<string[][]>([]);
  const [width, setWidth] = useState(6);
  const [height, setHeight] = useState(16);
  const [ready, setReady] = useState(!blobId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const { viewport, visibleRows, visibleColumns, onScroll } = useSpreadsheetViewport(height, width);

  useEffect(() => {
    dialog.current?.showModal();
    if (!blobId) return;
    let active = true;
    void downloadSessionBlob(blobId)
      .then((file) => file.text())
      .then((csv) => {
        if (!active) return;
        const data = csvParseRows(csv);
        setRows(data);
        setHeight(Math.max(16, data.length + 1));
        setWidth(Math.max(6, (data[0]?.length ?? 0) + 1));
        setReady(true);
      })
      .catch((reason: unknown) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [blobId]);

  function write(row: number, col: number, block: string[][]) {
    setRows((old) => {
      const next = old.slice();
      block.forEach((values, offset) => {
        const line = (next[row + offset] ?? []).slice();
        values.forEach((value, index) => {
          line[col + index] = value;
        });
        next[row + offset] = line;
      });
      return next;
    });
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
    if (!ready || saving) return;
    setError("");
    const data = rows.slice(1).filter((row) => row?.some((value) => value.trim() !== ""));
    if (!data.length) {
      setError("Enter at least one data row below the column names.");
      return;
    }
    let columns = 0;
    rows.forEach((row) =>
      row.forEach((value, col) => {
        if (value !== "") columns = Math.max(columns, col + 1);
      })
    );
    const headers = Array.from({ length: columns }, (_, col) => rows[0]?.[col]?.trim() || `column_${columnLabel(col)}`);
    if (new Set(headers.map((value) => value.toLowerCase())).size !== columns) {
      setError("Give each column a unique name.");
      return;
    }
    setSaving(true);
    try {
      const csv = csvFormatRows([headers, ...data.map((row) => headers.map((_, col) => row[col] ?? ""))]);
      await onSave(new File([csv], "entry.kavla-entry.csv", { type: ENTRY_MIME }));
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setSaving(false);
    }
  }

  return createPortal(
    <dialog
      ref={dialog}
      className="excel-dialog"
      aria-labelledby="entry-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose();
      }}
      onKeyDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <header className="excel-titlebar">
        <div>
          <FileSpreadsheet size={20} />
          <strong id="entry-title">Spreadsheet entry</strong>
        </div>
      </header>
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
                  disabled={!ready || saving}
                  placeholder={row === 0 ? "Column name" : ""}
                  onChange={(event) => write(row, col, [[event.target.value]])}
                  onKeyDown={(event) => navigate(event, row, col)}
                  onPaste={(event) => {
                    const value = event.clipboardData.getData("text/plain");
                    if (/[\t\r\n]/.test(value)) {
                      event.preventDefault();
                      write(row, col, tsvParseRows(value));
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
        <span>{ready ? "Row 1 names the columns. Type or paste your data below." : error ? "" : "Loading cells…"}</span>
        <button disabled={saving} onClick={onClose}>
          Cancel
        </button>
        <button className="excel-import-button" disabled={!ready || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </button>
      </footer>
    </dialog>,
    document.body
  );
}
