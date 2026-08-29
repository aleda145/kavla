import { useEffect, useState, type CSSProperties } from "react";
import { Copy } from "lucide-react";
import { useToasts } from "tldraw";
import type { SQLTextAreaShape } from "./sql-text-area-types";
import { getErrorMessage } from "../util/error-message";

const copyButtonClass =
  "h-9 px-3 border-2 border-black text-black font-bold text-xs flex items-center justify-center gap-2 rounded cursor-pointer transition-all active:translate-y-[1px] shadow-[2px_2px_0px_0px_rgba(0,0,0,0.2)] hover:shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]";

const footerStyle: CSSProperties = {
  padding: "8px",
  fontSize: 12,
  color: "#666",
  fontWeight: "bold",
  textAlign: "center",
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

export function SQLTextAreaFooter({ shape }: { shape: SQLTextAreaShape }) {
  const { addToast } = useToasts();

  if (shape.props.isRunning && shape.props.queryStartTime) {
    return (
      <div style={footerStyle}>
        <span style={{ marginRight: 6 }}>{shape.props.runnerName} is running</span>
        (<Timer startTime={shape.props.queryStartTime} />)
      </div>
    );
  }

  if (shape.props.error) {
    const errorMessage = getErrorMessage(shape.props.error);
    const copyError = () => {
      void navigator.clipboard.writeText(errorMessage);
      addToast({ title: "Copied to clipboard" });
    };

    return (
      <div
        style={{
          display: "flex",
          background: "#fef2f2",
          borderTop: "4px solid #000",
          borderBottomLeftRadius: 8,
          borderBottomRightRadius: 8,
        }}
      >
        <textarea
          readOnly
          onPointerDown={(event) => event.stopPropagation()}
          style={{
            flex: 1,
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

  if (shape.props.lastRunStats) {
    const { executionTime, rowCount, runnerName } = shape.props.lastRunStats;
    return (
      <div style={footerStyle}>
        <div style={{ display: "flex", gap: "4px", justifyContent: "center", alignItems: "center" }}>
          <span>{runnerName}</span>
          <span>ran query in</span>
          <span>{(executionTime / 1000).toFixed(2)}s</span>
          <span>·</span>
          <span>{rowCount.toLocaleString()}</span>
          <span>rows</span>
        </div>
      </div>
    );
  }

  return null;
}
