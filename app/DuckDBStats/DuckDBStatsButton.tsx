import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search } from "lucide-react";
import { siDuckdb } from "simple-icons";
import { createShapeId, useEditor, useToasts } from "tldraw";
import { useData } from "../client/useLocalServer";
import { executeSQLShape } from "../SQLTextArea/executeSQLShape";
import { DuckDBSettings } from "./DuckDBSettings";
import type { DataSourceShape } from "../DataSource/data-source-types";
import { calculateDataSourceHeight, calculateDataSourceWidth } from "../DataSource/ingestLocalDataSourceFile";
import { getFallbackNodePosition } from "../client/canvas/fallbackNodePosition";
import { getUniqueName } from "../util/getUniqueName";
import { connectShapes } from "../util/shapeConnections";

export function DuckDBStatsButton({ isComputing }: { isComputing: boolean }) {
  const editor = useEditor();
  const data = useData();
  const { addToast } = useToasts();
  const [open, setOpen] = useState(false);
  const keepOpen = useRef(false);
  const close = () => {
    setOpen(false);
    keepOpen.current = false;
  };
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelClose = () => clearTimeout(timer.current);
  const show = () => {
    cancelClose();
    setOpen(true);
  };
  const scheduleClose = () => {
    cancelClose();
    if (keepOpen.current) return;
    timer.current = setTimeout(() => {
      if (panel.current?.contains(document.activeElement) || trigger.current === document.activeElement) return;
      close();
    }, 150);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(360, window.innerWidth - 16);
      setPosition({
        left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
        top: rect.bottom + 8,
      });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (!trigger.current?.contains(event.target) && !panel.current?.contains(event.target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (panel.current?.contains(document.activeElement)) trigger.current?.focus();
        close();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  async function queryStats() {
    const sourceId = createShapeId();
    const queryId = createShapeId();
    const name = getUniqueName(editor, "duckdb_stats");
    const sql = `SELECT\n  *\nFROM\n  ${name}\nORDER BY\n  timestamp DESC`;
    const center = editor.getViewportPageBounds().center;
    const w = calculateDataSourceWidth(null, "duckdb_stats");
    const h = calculateDataSourceHeight(null, null);
    editor.markHistoryStoppingPoint("Query DuckDB stats");
    editor.run(() => {
      editor.createShape<DataSourceShape>({
        id: sourceId,
        type: "data-source",
        x: center.x - w / 2,
        y: center.y - h / 2,
        props: {
          w,
          h,
          name,
          filename: "duckdb_stats",
          sourceName: "memory",
          sourceType: "duckdb",
          remoteTableRef: "memory.kavla.duckdb_stats",
        },
      });
      editor.createShape({
        id: queryId,
        type: "sql-text-area",
        ...getFallbackNodePosition(editor, sourceId),
        props: { w: 400, text: sql },
      });
      connectShapes(editor, sourceId, queryId);
      editor.select(sourceId, queryId);
    });
    editor.zoomToSelection({ animation: { duration: 250 } });
    close();
    try {
      await executeSQLShape(editor, data, queryId, sql, new AbortController().signal);
    } catch (error) {
      addToast({
        title: "Could not run stats query",
        description: error instanceof Error ? error.message : String(error),
        severity: "error",
      });
    }
  }
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label="DuckDB settings"
        aria-expanded={open}
        aria-haspopup="dialog"
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") show();
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            show();
            requestAnimationFrame(() => panel.current?.querySelector("button")?.focus());
          }
        }}
        onPointerLeave={scheduleClose}
        onFocus={show}
        onBlur={scheduleClose}
        onClick={() => {
          show();
          keepOpen.current = true;
          requestAnimationFrame(() => panel.current?.focus());
        }}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: 24,
          padding: "2px 6px",
          border: "2px solid #000",
          borderRadius: 4,
          boxShadow: "2px 2px 0 0 #000",
          cursor: "pointer",
          backgroundColor: isComputing ? "#fef08a" : "#f1f5f9",
        }}
      >
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          width={12}
          height={12}
          style={{ fill: isComputing ? "#000" : "#94a3b8", transition: "fill 0.2s ease" }}
        >
          <path d={siDuckdb.path} />
        </svg>
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            tabIndex={-1}
            role="dialog"
            aria-label="DuckDB settings"
            onPointerEnter={cancelClose}
            onPointerLeave={scheduleClose}
            onFocus={cancelClose}
            onBlur={scheduleClose}
            onWheel={(event) => event.stopPropagation()}
            style={{
              position: "fixed",
              ...position,
              width: "min(360px, calc(100vw - 16px))",
              maxHeight: `calc(100vh - ${position.top + 8}px)`,
              overflowY: "auto",
              zIndex: 2147483647,
              border: "2px solid #000",
              borderRadius: 4,
              boxShadow: "4px 4px 0 #000",
            }}
          >
            <div className="duckdb-settings-header">
              <strong>DuckDB</strong>
              <div className="duckdb-header-actions">
                <button type="button" title="Query DuckDB stats" aria-label="Query DuckDB stats" onClick={queryStats}>
                  <Search size={13} aria-hidden="true" />
                  <span className="kavla-control-label">Query</span>
                </button>
              </div>
            </div>
            <DuckDBSettings />
          </div>,
          document.body
        )}
    </>
  );
}
