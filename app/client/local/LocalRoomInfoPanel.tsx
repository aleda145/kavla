import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pin, Terminal } from "lucide-react";
import { siDuckdb, siGithub } from "simple-icons";
import { createShapeId, useEditor, useValue } from "tldraw";
import { isDuckDBComputing } from "../../src/duckdb-service";
import { getCliTerminalDisplay } from "../cliTerminalDisplay";
import { useCliOutput, useCliStatus } from "../localServer/runtimeStore";

const DISCORD_INVITE_URL = "https://discord.gg/aeBGuDdhtP";
const GITHUB_REPOSITORY_URL = "https://github.com/aleda145/kavla";

function DiscordIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" style={{ width: 14, height: 14, fill: "currentColor" }}>
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037 3.903 3.903 0 0 0-.461.965 18.258 18.258 0 0 0-5.786 0 3.883 3.883 0 0 0-.47-.965.075.075 0 0 0-.08-.037A19.736 19.736 0 0 0 3.677 4.37a.077.077 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.074.074 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.419 0 1.334-.956 2.419-2.157 2.419zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.419 0 1.334-.946 2.419-2.157 2.419z" />
    </svg>
  );
}

const lightStyle = {
  alignItems: "center",
  border: "2px solid #000",
  borderRadius: 4,
  boxShadow: "2px 2px 0 0 #000",
  display: "flex",
  height: 24,
  justifyContent: "center",
  padding: "2px 6px",
} as const;

function formatCompactFileSize(fileSize: number): string {
  const megabytes = fileSize / (1024 * 1024);
  if (megabytes === 0) return "0 MB";
  if (megabytes < 0.1) return "<0.1 MB";
  if (megabytes < 999.5) {
    return `${Number(megabytes.toPrecision(3))} MB`;
  }
  return `${Number((megabytes / 1024).toPrecision(3))} GB`;
}

export function LocalRoomInfoPanel({ fileSize }: { fileSize: number | null }) {
  const editor = useEditor();
  const cliConnected = useCliStatus();
  const cliOutput = useCliOutput();
  const cliTerminalDisplay = getCliTerminalDisplay(cliConnected, cliOutput);
  const isComputingRaw = useValue("is DuckDB computing", () => isDuckDBComputing.get(), []);
  const [isComputing, setIsComputing] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalPosition, setTerminalPosition] = useState({ left: 0, top: 0 });
  const terminalTriggerRef = useRef<HTMLButtonElement>(null);
  const terminalPopoverRef = useRef<HTMLDivElement>(null);
  const terminalOutputRef = useRef<HTMLDivElement>(null);
  const terminalCloseTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setIsComputing(isComputingRaw), isComputingRaw ? 50 : 500);

    return () => window.clearTimeout(timer);
  }, [isComputingRaw]);

  const cancelTerminalClose = useCallback(() => {
    if (terminalCloseTimerRef.current === null) return;
    window.clearTimeout(terminalCloseTimerRef.current);
    terminalCloseTimerRef.current = null;
  }, []);

  const scheduleTerminalClose = useCallback(() => {
    cancelTerminalClose();
    terminalCloseTimerRef.current = window.setTimeout(() => {
      setTerminalOpen(false);
      terminalCloseTimerRef.current = null;
    }, 150);
  }, [cancelTerminalClose]);

  useLayoutEffect(() => {
    if (!terminalOpen) return;

    const updatePosition = () => {
      const trigger = terminalTriggerRef.current;
      if (!trigger) return;
      const triggerBounds = trigger.getBoundingClientRect();
      const terminalWidth = Math.min(360, window.innerWidth - 16);
      setTerminalPosition({
        left: Math.max(8, Math.min(triggerBounds.right - terminalWidth, window.innerWidth - terminalWidth - 8)),
        top: triggerBounds.bottom + 8,
      });
    };

    updatePosition();
    const updatePositionForScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && terminalPopoverRef.current?.contains(target)) return;
      updatePosition();
    };

    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePositionForScroll, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePositionForScroll, true);
    };
  }, [terminalOpen]);

  useLayoutEffect(() => {
    if (!terminalOpen || !terminalOutputRef.current) return;
    terminalOutputRef.current.scrollTop = terminalOutputRef.current.scrollHeight;
  }, [cliOutput, terminalOpen]);

  useEffect(() => {
    if (!terminalOpen) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (terminalTriggerRef.current?.contains(target) || terminalPopoverRef.current?.contains(target)) return;
      setTerminalOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTerminalOpen(false);
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [terminalOpen]);

  useEffect(() => () => cancelTerminalClose(), [cancelTerminalClose]);

  const pinTerminalToCanvas = useCallback(() => {
    const viewport = editor.getViewportPageBounds();
    editor.createShape({
      id: createShapeId(),
      type: "cli-terminal",
      x: viewport.center.x - 200,
      y: viewport.center.y - 125,
      props: { w: 400, h: 250 },
    });
  }, [editor]);

  return (
    <div className="pointer-events-none flex flex-col items-end">
      <div
        className="pointer-events-auto flex select-none items-center gap-2 border-b-2 border-l-2 border-black bg-white p-3"
        style={{ borderRadius: "0 0 0 12px" }}
      >
        <div
          style={{ position: "relative" }}
          onPointerEnter={(event) => {
            if (event.pointerType !== "mouse") return;
            cancelTerminalClose();
            setTerminalOpen(true);
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === "mouse") scheduleTerminalClose();
          }}
        >
          <button
            ref={terminalTriggerRef}
            aria-expanded={terminalOpen}
            aria-haspopup="dialog"
            aria-label={cliConnected ? "Kavla CLI connected" : "Kavla CLI disconnected"}
            onClick={() => {
              cancelTerminalClose();
              setTerminalOpen(true);
            }}
            onFocus={() => {
              cancelTerminalClose();
              setTerminalOpen(true);
            }}
            onBlur={scheduleTerminalClose}
            style={{
              ...lightStyle,
              backgroundColor: "#dcfce7",
              color: cliConnected ? "#15803d" : "#166534",
              cursor: "help",
            }}
            title="Kavla CLI"
            type="button"
          >
            <Terminal size={12} strokeWidth={3} />
          </button>

          {terminalOpen &&
            createPortal(
              <div
                ref={terminalPopoverRef}
                role="dialog"
                aria-label="Kavla CLI terminal"
                onWheel={(event) => event.stopPropagation()}
                onPointerEnter={cancelTerminalClose}
                onPointerLeave={scheduleTerminalClose}
                style={{
                  position: "fixed",
                  left: terminalPosition.left,
                  top: terminalPosition.top,
                  width: "min(360px, calc(100vw - 16px))",
                  zIndex: 2147483647,
                }}
              >
                <div
                  style={{
                    backgroundColor: "#1a1a2e",
                    border: "2px solid #000",
                    borderRadius: 4,
                    boxShadow: "3px 3px 0 0 #000",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      alignItems: "center",
                      backgroundColor: "#16213e",
                      borderBottom: "1px solid #0f3460",
                      display: "flex",
                      gap: 6,
                      padding: "6px 10px",
                    }}
                  >
                    <div
                      style={{
                        backgroundColor:
                          cliTerminalDisplay.tone === "connected"
                            ? "#4ade80"
                            : cliTerminalDisplay.tone === "disconnected"
                              ? "#ef4444"
                              : "#94a3b8",
                        borderRadius: "50%",
                        height: 8,
                        width: 8,
                      }}
                    />
                    <span
                      style={{
                        color: "#94a3b8",
                        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                        fontSize: 10,
                        fontWeight: 600,
                      }}
                    >
                      kavla cli — {cliTerminalDisplay.headerLabel}
                    </span>
                    <button
                      onClick={pinTerminalToCanvas}
                      style={{
                        alignItems: "center",
                        backgroundColor: "#fff",
                        border: "2px solid #000",
                        borderRadius: 4,
                        boxShadow: "2px 2px 0 0 rgba(0,0,0,0.2)",
                        color: "#000",
                        cursor: "pointer",
                        display: "flex",
                        fontSize: 10,
                        fontWeight: 700,
                        gap: 4,
                        height: 24,
                        marginLeft: "auto",
                        padding: "0 8px",
                      }}
                      title="Pin to canvas"
                      type="button"
                    >
                      <Pin size={10} strokeWidth={2.5} />
                      Pin to canvas
                    </button>
                  </div>
                  <div
                    ref={terminalOutputRef}
                    onWheel={(event) => event.stopPropagation()}
                    style={{
                      color: "#e2e8f0",
                      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                      fontSize: 10,
                      lineHeight: 1.6,
                      maxHeight: 200,
                      minHeight: 42,
                      overflowY: "auto",
                      padding: "8px 10px",
                    }}
                  >
                    {cliTerminalDisplay.hasHistory ? (
                      cliOutput.map((entry, index) => (
                        <div
                          key={`${entry.timestamp}-${index}`}
                          style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}
                        >
                          {entry.line}
                        </div>
                      ))
                    ) : (
                      <div style={{ color: "#64748b", fontStyle: "italic" }}>{cliTerminalDisplay.emptyStateText}</div>
                    )}
                  </div>
                </div>
              </div>,
              document.body
            )}
        </div>

        <div
          aria-label={isComputing ? "DuckDB is computing" : "DuckDB is idle"}
          role="status"
          style={{
            ...lightStyle,
            backgroundColor: isComputing ? "#fef08a" : "#f1f5f9",
          }}
          title={isComputing ? "DuckDB is computing" : "DuckDB is idle"}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            style={{
              width: 12,
              height: 12,
              fill: isComputing ? "#000" : "#94a3b8",
              transition: "fill 0.2s ease",
            }}
          >
            <path d={siDuckdb.path} />
          </svg>
        </div>

        <a
          aria-label="View Kavla on GitHub"
          data-allow-middle-click
          href={GITHUB_REPOSITORY_URL}
          rel="noopener noreferrer"
          style={{
            ...lightStyle,
            backgroundColor: "#f1f5f9",
            color: "#000",
            textDecoration: "none",
          }}
          target="_blank"
          title="View Kavla on GitHub"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" style={{ width: 14, height: 14, fill: "currentColor" }}>
            <path d={siGithub.path} />
          </svg>
        </a>

        <a
          aria-label="Join the Kavla Discord"
          data-allow-middle-click
          href={DISCORD_INVITE_URL}
          rel="noopener noreferrer"
          style={{
            ...lightStyle,
            backgroundColor: "#eef2ff",
            color: "#5865f2",
            textDecoration: "none",
          }}
          target="_blank"
          title="Join the Kavla Discord"
        >
          <DiscordIcon />
        </a>
      </div>
      {fileSize !== null ? (
        <div
          aria-label={`Saved Kavla file size: ${formatCompactFileSize(fileSize)}`}
          className="pointer-events-auto select-none border-b-2 border-l-2 border-black bg-white px-2 py-1"
          style={{
            borderRadius: "0 0 0 8px",
            fontFamily: "Inter, sans-serif",
            fontSize: 10,
            fontWeight: 850,
            lineHeight: 1,
          }}
          title="Size of the saved .kavla document on disk"
        >
          {formatCompactFileSize(fileSize)}
        </div>
      ) : null}
    </div>
  );
}
