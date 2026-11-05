import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pin } from "lucide-react";
import { siDuckdb } from "simple-icons";
import { createShapeId, useEditor } from "tldraw";
import { DuckDBStatsPanel } from "./DuckDBStatsPanel";

export function DuckDBStatsButton({ isComputing }: { isComputing: boolean }) {
  const editor = useEditor();
  const [open, setOpen] = useState(false);
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
    timer.current = setTimeout(() => {
      if (panel.current?.contains(document.activeElement) || trigger.current === document.activeElement) return;
      setOpen(false);
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
      if (!trigger.current?.contains(event.target) && !panel.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (panel.current?.contains(document.activeElement)) trigger.current?.focus();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label="DuckDB process stats"
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
        onClick={show}
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
            role="dialog"
            aria-label="DuckDB process stats"
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
            <DuckDBStatsPanel
              action={
                <button
                  type="button"
                  title="Pin DuckDB stats to canvas"
                  aria-label="Pin DuckDB stats to canvas"
                  onClick={() => {
                    const viewport = editor.getViewportPageBounds();
                    editor.createShape({
                      id: createShapeId(),
                      type: "duckdb-stats",
                      x: viewport.center.x - 180,
                      y: viewport.center.y - 185,
                      props: { w: 360, h: 370 },
                    });
                    setOpen(false);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    height: 24,
                    padding: "0 6px",
                    border: "2px solid #000",
                    borderRadius: 4,
                    background: "#fff",
                    color: "#000",
                    fontSize: 10,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  <Pin size={12} />
                  <span className="kavla-control-label">Pin to canvas</span>
                </button>
              }
            />
          </div>,
          document.body
        )}
    </>
  );
}
