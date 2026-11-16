import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createRoot } from "react-dom/client";
import { Check, ChevronDown, FileSpreadsheet, Loader2, MousePointer2, X } from "lucide-react";
import { backendRequest, withBackendActivity } from "../client/backendCompute";
import { getActiveLocalSession } from "../client/local/localSession";
import {
  cellLabel,
  columnLabel,
  excelColumns,
  parseCell,
  rangeLabel,
  suggestExcelSelection,
  type ExcelImportConfig,
  type ExcelImportResult,
  type ExcelSheet,
  type ExcelWorkbook,
} from "./excel-import";
import "./excel-import.css";

type ImportOptions = { file?: File; config?: ExcelImportConfig };
type DialogProps = ImportOptions & { onClose: (result: ExcelImportResult | null) => void };
let dialogQueue: Promise<unknown> = Promise.resolve();

export function openExcelImport(options: ImportOptions): Promise<ExcelImportResult | null> {
  const documentId = getActiveLocalSession()?.documentId;
  const task = dialogQueue.then(
    () =>
      new Promise<ExcelImportResult | null>((resolve) => {
        if (getActiveLocalSession()?.documentId !== documentId) {
          resolve(null);
          return;
        }
        const container = document.createElement("div");
        document.body.appendChild(container);
        const root = createRoot(container);
        const close = (result: ExcelImportResult | null) => {
          root.unmount();
          container.remove();
          resolve(result);
        };
        root.render(<ExcelImportDialog {...options} onClose={close} />);
      })
  );
  dialogQueue = task.catch(() => undefined);
  return task;
}

function ExcelImportDialog({ file, config: initialConfig, onClose }: DialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const controller = useRef(new AbortController());
  const [workbook, setWorkbook] = useState<ExcelWorkbook | null>(null);
  const [config, setConfig] = useState<ExcelImportConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pickHeader, setPickHeader] = useState(!initialConfig);
  const sheetSelections = useRef(new Map<string, ExcelImportConfig>());
  const [rangeText, setRangeText] = useState("");
  const [rangeError, setRangeError] = useState<string | null>(null);
  const sheet = workbook?.sheets.find((candidate) => candidate.name === config?.sheet);
  const dataRowCount = useMemo(() => {
    if (!config || !sheet?.rows.length) return 0;
    const firstRow = config.headerRow === null ? config.startRow : config.headerRow + 1;
    if (!config.skipEmptyRows) return Math.max(0, config.endRow - firstRow + 1);
    let count = 0;
    for (let row = firstRow; row <= config.endRow; row++) {
      if (config.columns.some((col) => (sheet.rows[row]?.[col] ?? "") !== "")) count++;
    }
    return count;
  }, [config, sheet]);

  const requestBody = () => {
    const body = new FormData();
    if (file) body.set("file", file);
    else if (initialConfig) body.set("workbookId", initialConfig.workbookId);
    return body;
  };

  useEffect(() => {
    dialog.current?.showModal();
    const abort = controller.current;
    const documentId = getActiveLocalSession()?.documentId;
    const reset = () => {
      if (getActiveLocalSession()?.documentId !== documentId) {
        abort.abort();
        onClose(null);
      }
    };
    window.addEventListener("kavla:backend-reset", reset);
    void backendRequest("/api/session/uploads/excel/preview", {
      method: "POST",
      body: requestBody(),
      signal: abort.signal,
    })
      .then((response) => response.json() as Promise<ExcelWorkbook>)
      .then((result) => {
        if (abort.signal.aborted) return;
        setWorkbook(result);
        const firstSheet =
          result.sheets.find((candidate) => candidate.name === initialConfig?.sheet) ??
          result.sheets.find((candidate) => candidate.columnCount > 0) ??
          result.sheets[0];
        if (!firstSheet) throw new Error("This workbook contains no worksheets.");
        const selection = initialConfig ?? suggestExcelSelection(firstSheet);
        setConfig({ ...selection, columns: excelColumns(selection.startCol, selection.endCol) });
      })
      .catch((reason: unknown) => {
        if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => {
      abort.abort();
      window.removeEventListener("kavla:backend-reset", reset);
    };
  }, []);

  useEffect(() => {
    if (config) setRangeText(rangeLabel(config));
    setRangeError(null);
  }, [config?.startRow, config?.endRow, config?.startCol, config?.endCol, config?.sheet]);

  const updateRange = (startRow: number, endRow: number, startCol: number, endCol: number) => {
    setConfig((previous) =>
      !previous ||
      (previous.startRow === startRow &&
        previous.endRow === endRow &&
        previous.startCol === startCol &&
        previous.endCol === endCol &&
        previous.headerRow === startRow)
        ? previous
        : {
            ...previous,
            startRow,
            endRow,
            startCol,
            endCol,
            columns: excelColumns(startCol, endCol),
            headerRow: startRow,
          }
    );
  };
  const applyRangeText = () => {
    if (!sheet) return;
    const parts = rangeText.split(":");
    const start = parseCell(parts[0]);
    const end = parseCell(parts[1] ?? parts[0]);
    if (
      parts.length > 2 ||
      !start ||
      !end ||
      start.row > end.row ||
      start.col > end.col ||
      end.row >= sheet.rows.length ||
      end.col >= sheet.columnCount
    ) {
      setRangeError("Enter a range inside this sheet, such as B3:H120.");
      return;
    }
    setRangeError(null);
    updateRange(start.row, end.row, start.col, end.col);
    setPickHeader(false);
  };
  const importSelection = async () => {
    if (!config || !dataRowCount || !config.columns.length || saving || rangeError) return;
    setSaving(true);
    setError(null);
    try {
      const body = requestBody();
      body.set("config", JSON.stringify(config));
      const result = await withBackendActivity(async () => {
        const response = await backendRequest("/api/session/uploads/excel", {
          method: "POST",
          body,
          signal: controller.current.signal,
        });
        return response.json() as Promise<ExcelImportResult>;
      });
      if (!controller.current.signal.aborted) onClose(result);
    } catch (reason) {
      if (!controller.current.signal.aborted) {
        setError(reason instanceof Error ? reason.message : String(reason));
        setSaving(false);
      }
    }
  };

  return (
    <dialog
      ref={dialog}
      className="excel-dialog"
      aria-labelledby="excel-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose(null);
      }}
      onKeyDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header className="excel-titlebar">
        <div>
          <FileSpreadsheet size={21} />
          <strong id="excel-title">{initialConfig ? "Edit Excel selection" : "Import Excel"}</strong>
          <span>{workbook?.fileName ?? file?.name}</span>
        </div>
        <button
          type="button"
          aria-label="Close Excel import"
          title="Close"
          disabled={saving}
          onClick={() => onClose(null)}
        >
          <X size={20} />
        </button>
      </header>
      {loading ? (
        <div className="excel-loading">
          <Loader2 className="animate-spin" /> Reading workbook…
        </div>
      ) : config && sheet && workbook ? (
        <>
          <fieldset className="excel-controls" disabled={saving}>
            <label>
              Sheet ({workbook.sheets.length})
              <span className="excel-sheet-dropdown">
                <select
                  aria-label="Choose worksheet"
                  value={config.sheet}
                  onChange={(event) => {
                    const next = workbook.sheets.find((candidate) => candidate.name === event.target.value)!;
                    sheetSelections.current.set(config.sheet, config);
                    setConfig(sheetSelections.current.get(next.name) ?? suggestExcelSelection(next, config.workbookId));
                    setPickHeader(!sheetSelections.current.has(next.name));
                    setError(null);
                  }}
                >
                  {workbook.sheets.map((candidate) => (
                    <option key={candidate.name} value={candidate.name}>
                      {candidate.name}
                    </option>
                  ))}
                </select>
                <ChevronDown size={16} aria-hidden="true" />
              </span>
            </label>
            <label>
              Range
              <input
                aria-invalid={Boolean(rangeError)}
                value={rangeText}
                onChange={(event) => {
                  setRangeText(event.target.value);
                  setRangeError(null);
                }}
                onBlur={applyRangeText}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    applyRangeText();
                  }
                }}
                spellCheck={false}
              />
            </label>
            <button
              type="button"
              className={pickHeader ? "excel-active" : ""}
              aria-pressed={pickHeader}
              onClick={() => setPickHeader(!pickHeader)}
            >
              <MousePointer2 size={16} />
              {pickHeader ? "Click your header row…" : "Pick header row"}
            </button>
            <label className="excel-checkbox">
              <input
                type="checkbox"
                checked={config.skipEmptyRows}
                onChange={(event) => setConfig({ ...config, skipEmptyRows: event.target.checked })}
              />
              Skip empty rows
            </label>
          </fieldset>
          <div className="excel-help">
            {pickHeader
              ? "Click a row to use as headers. The selection includes all columns through the last row."
              : "Drag to select a range, or type one above. The first row becomes the header."}{" "}
            <span className="excel-header-key">
              {config.headerRow === null ? "No header" : `Header: row ${config.headerRow + 1}`}
            </span>
          </div>
          {sheet.columnCount > 0 && sheet.rows.length > 0 ? (
            <SpreadsheetGrid
              key={sheet.name}
              sheet={sheet}
              config={config}
              disabled={saving}
              pickHeader={pickHeader}
              onHeader={(row) => {
                setConfig({
                  ...config,
                  startRow: row,
                  endRow: sheet.rows.length - 1,
                  startCol: 0,
                  endCol: sheet.columnCount - 1,
                  headerRow: row,
                  columns: excelColumns(0, sheet.columnCount - 1),
                });
                setPickHeader(false);
              }}
              onRange={updateRange}
            />
          ) : (
            <div className="excel-loading">This sheet is empty. Choose another sheet.</div>
          )}
          {!dataRowCount && sheet.rows.length > 0 && (
            <div className="excel-help" role="status">
              Choose a header with data rows below it.
            </div>
          )}
        </>
      ) : null}
      {(error || rangeError) && (
        <div className="excel-error" role="alert">
          {error ?? rangeError}
        </div>
      )}
      <footer className="excel-footer">
        <span>
          {config ? `${dataRowCount.toLocaleString()} rows · ${config.columns.length.toLocaleString()} columns` : ""}
        </span>
        <button type="button" disabled={saving} onClick={() => onClose(null)}>
          Cancel
        </button>
        <button
          type="button"
          className="excel-import-button"
          disabled={loading || saving || !dataRowCount || !config?.columns.length || Boolean(rangeError)}
          onClick={() => void importSelection()}
        >
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
          {saving ? "Importing…" : "Import"}
        </button>
      </footer>
    </dialog>
  );
}

const CELL_WIDTH = 128;
const CELL_HEIGHT = 28;
const ROW_HEADER_WIDTH = 52;

type GridProps = {
  sheet: ExcelSheet;
  config: ExcelImportConfig;
  disabled: boolean;
  pickHeader: boolean;
  onHeader: (row: number) => void;
  onRange: (startRow: number, endRow: number, startCol: number, endCol: number) => void;
};
type DragSelection = { row: number; col: number; mode: "cell" | "row" | "column"; x: number; y: number };

function SpreadsheetGrid({ sheet, config, disabled, pickHeader, onHeader, onRange }: GridProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<DragSelection | null>(null);
  const [windowSize, setWindowSize] = useState({ top: 0, left: 0, width: 1000, height: 300 });
  const callbacks = useRef({ onRange, sheet });
  callbacks.current = { onRange, sheet };

  useEffect(() => {
    const element = viewport.current!;
    const resize = () =>
      setWindowSize({
        top: element.scrollTop,
        left: element.scrollLeft,
        width: element.clientWidth,
        height: element.clientHeight,
      });
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    let frame = 0;
    const tick = () => {
      const selection = drag.current;
      if (selection) {
        const bounds = element.getBoundingClientRect();
        if (selection.y < bounds.top + CELL_HEIGHT) element.scrollTop -= 14;
        if (selection.y > bounds.bottom - 20) element.scrollTop += 14;
        if (selection.x < bounds.left + ROW_HEADER_WIDTH) element.scrollLeft -= 14;
        if (selection.x > bounds.right - 20) element.scrollLeft += 14;
        const { sheet: currentSheet, onRange: select } = callbacks.current;
        const row = Math.max(
          0,
          Math.min(
            currentSheet.rows.length - 1,
            Math.floor((selection.y - bounds.top + element.scrollTop - CELL_HEIGHT) / CELL_HEIGHT)
          )
        );
        const col = Math.max(
          0,
          Math.min(
            currentSheet.columnCount - 1,
            Math.floor((selection.x - bounds.left + element.scrollLeft - ROW_HEADER_WIDTH) / CELL_WIDTH)
          )
        );
        select(
          selection.mode === "column" ? 0 : Math.min(selection.row, row),
          selection.mode === "column" ? currentSheet.rows.length - 1 : Math.max(selection.row, row),
          selection.mode === "row" ? 0 : Math.min(selection.col, col),
          selection.mode === "row" ? currentSheet.columnCount - 1 : Math.max(selection.col, col)
        );
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  const start = (event: ReactPointerEvent, row: number, col: number, mode: DragSelection["mode"]) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    if (pickHeader) {
      onHeader(row);
      return;
    }
    drag.current = { row, col, mode, x: event.clientX, y: event.clientY };
    viewport.current?.setPointerCapture(event.pointerId);
    onRange(
      mode === "column" ? 0 : row,
      mode === "column" ? sheet.rows.length - 1 : row,
      mode === "row" ? 0 : col,
      mode === "row" ? sheet.columnCount - 1 : col
    );
  };
  const visibleRows = excelColumns(
    Math.max(0, Math.floor(windowSize.top / CELL_HEIGHT) - 2),
    Math.min(sheet.rows.length - 1, Math.ceil((windowSize.top + windowSize.height) / CELL_HEIGHT))
  );
  const visibleColumns = excelColumns(
    Math.max(0, Math.floor(windowSize.left / CELL_WIDTH) - 1),
    Math.min(sheet.columnCount - 1, Math.ceil((windowSize.left + windowSize.width) / CELL_WIDTH))
  );
  const included = new Set(config.columns);

  return (
    <div
      ref={viewport}
      className={`excel-grid${pickHeader ? " excel-pick-header" : ""}`}
      role="region"
      aria-label="Worksheet selection grid"
      tabIndex={0}
      onScroll={(event) => {
        const { scrollTop, scrollLeft } = event.currentTarget;
        setWindowSize((previous) => ({ ...previous, top: scrollTop, left: scrollLeft }));
      }}
      onPointerMove={(event) => {
        if (drag.current) {
          drag.current.x = event.clientX;
          drag.current.y = event.clientY;
        }
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
    >
      <div
        style={{
          width: ROW_HEADER_WIDTH + sheet.columnCount * CELL_WIDTH,
          height: (sheet.rows.length + 1) * CELL_HEIGHT,
          position: "relative",
        }}
      >
        <div className="excel-column-headers" style={{ height: CELL_HEIGHT }}>
          <div className="excel-corner" style={{ width: ROW_HEADER_WIDTH }}>
            #
          </div>
          {visibleColumns.map((col) => (
            <div
              key={col}
              className={`excel-column-letter${included.has(col) ? " excel-selected" : ""}`}
              style={{ left: ROW_HEADER_WIDTH + col * CELL_WIDTH, width: CELL_WIDTH }}
              onPointerDown={(event) => start(event, config.startRow, col, "column")}
            >
              {columnLabel(col)}
            </div>
          ))}
        </div>
        {visibleRows.map((row) => (
          <div key={row} className="excel-grid-row" style={{ top: (row + 1) * CELL_HEIGHT, height: CELL_HEIGHT }}>
            <div
              className={`excel-row-number${row === config.headerRow ? " excel-header-cell" : ""}`}
              style={{ width: ROW_HEADER_WIDTH }}
              onPointerDown={(event) => start(event, row, config.startCol, "row")}
            >
              {row + 1}
            </div>
            {visibleColumns.map((col) => {
              const inRange =
                row >= config.startRow && row <= config.endRow && col >= config.startCol && col <= config.endCol;
              const selected = inRange && included.has(col);
              const header = selected && row === config.headerRow;
              const data = selected && (config.headerRow === null || row > config.headerRow);
              const value = sheet.rows[row]?.[col] ?? "";
              return (
                <div
                  key={col}
                  title={`${cellLabel(row, col)}${value ? `: ${value}` : ""}`}
                  className={`excel-cell${header ? " excel-header-cell" : data ? " excel-selected" : inRange ? " excel-excluded" : ""}`}
                  style={{ left: ROW_HEADER_WIDTH + col * CELL_WIDTH, width: CELL_WIDTH }}
                  onPointerDown={(event) => start(event, row, col, "cell")}
                >
                  {value}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
