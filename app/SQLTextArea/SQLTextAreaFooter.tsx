import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Copy } from "lucide-react";
import { useToasts } from "tldraw";
import type { SQLTextAreaShape } from "./sql-text-area-types";
import { getErrorMessage } from "../util/error-message";
import { formatEstimatedQueryCost, formatProcessedBytes } from "../client/queryEstimate";

const copyButtonClass =
  "h-9 px-3 border-2 border-black text-black font-bold text-xs flex items-center justify-center gap-2 rounded cursor-pointer transition-all active:translate-y-[1px] shadow-[2px_2px_0px_0px_rgba(0,0,0,0.2)] hover:shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]";

const footerStyle: CSSProperties = {
  padding: 0,
  flexShrink: 0,
  fontSize: 11,
  color: "#666",
  fontWeight: "bold",
  textAlign: "left",
  borderTop: "4px solid #000",
  background: "#f3f4f6",
  borderBottomLeftRadius: 8,
  borderBottomRightRadius: 8,
};

function Timer({ startTime }: { startTime: number }) {
  const [time, setTime] = useState(Date.now());

  useEffect(() => {
    const interval = setInterval(() => setTime(Date.now()), 100);
    return () => {
      clearInterval(interval);
    };
  }, []);

  const elapsed = (time - startTime) / 1000;
  return <span>{elapsed.toFixed(1)}s</span>;
}

export function SQLTextAreaFooter({ shape, estimate }: { shape: SQLTextAreaShape; estimate?: ReactNode }) {
  const { addToast } = useToasts();
  const running = shape.props.isRunning && shape.props.queryStartTime !== null;
  const stats = shape.props.lastRunStats;
  let errorContent: ReactNode = null;
  if (shape.props.error && !running) {
    const errorMessage = getErrorMessage(shape.props.error);
    const copyError = () => {
      void navigator.clipboard.writeText(errorMessage);
      addToast({ title: "Copied to clipboard" });
    };

    errorContent = (
      <div
        style={{
          display: "flex",
          background: "#fef2f2",
          borderBottomLeftRadius: 8,
          borderBottomRightRadius: 8,
        }}
      >
        <textarea
          readOnly
          aria-label="Query error"
          onPointerDown={(event) => event.stopPropagation()}
          style={{
            flex: 1,
            minHeight: 0,
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
            borderBottomLeftRadius: 8,
          }}
          value={errorMessage}
          rows={errorMessage.split("\n").length + 1}
        />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
            alignItems: "center",
            padding: 8,
            backgroundColor: "#fee2e2",
            gap: 6,
            borderBottomRightRadius: 8,
          }}
        >
          <button
            onClick={copyError}
            onPointerDown={(event) => {
              event.stopPropagation();
              if (event.pointerType === "touch") copyError();
            }}
            className={copyButtonClass}
            style={{ width: "40px", padding: "8px", justifyContent: "center", touchAction: "none" }}
            title="Copy Error"
          >
            <Copy size={16} />
          </button>
        </div>
      </div>
    );
  }

  if (!running && !errorContent && !stats && !estimate) return null;

  return (
    <div style={footerStyle}>
      {errorContent}
      {(running || stats || estimate) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 12,
            padding: "6px 8px",
          }}
        >
          <span className="flex flex-wrap items-center gap-2">
            <span title={stats?.runnerName}>
              {running ? (
                <>
                  Running · <Timer startTime={shape.props.queryStartTime!} />
                </>
              ) : stats ? (
                <>
                  {stats.rowCount.toLocaleString()} rows <span aria-hidden>|</span>{" "}
                  {(stats.executionTime / 1000).toFixed(2)} s
                </>
              ) : (
                "Not run"
              )}
            </span>
            {estimate && (
              <>
                <span aria-hidden>|</span>
                <span
                  title={
                    stats?.scan?.bytesProcessed !== undefined
                      ? formatEstimatedQueryCost(stats.scan.bytesProcessed)
                      : undefined
                  }
                >
                  Scanned:{" "}
                  {stats?.scan?.bytesProcessed !== undefined ? formatProcessedBytes(stats.scan.bytesProcessed) : "—"}
                </span>
              </>
            )}
          </span>
          {estimate && <span className="ml-auto min-w-0 whitespace-nowrap">{estimate}</span>}
        </div>
      )}
    </div>
  );
}
