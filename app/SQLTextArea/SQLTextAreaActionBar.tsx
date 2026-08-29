import { BarChart3, Eye, EyeOff, Play, Search, Square } from "lucide-react";
import type { SQLTextAreaShape } from "./sql-text-area-types";

const buttonBaseClass =
  "h-9 px-3 border-2 border-black text-black font-bold text-xs flex items-center justify-center gap-2 rounded cursor-pointer transition-all active:translate-y-[1px]";

const buttonShadowClass = "shadow-[2px_2px_0px_0px_rgba(0,0,0,0.2)] hover:shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]";

const buttonPressedClass = "shadow-[inset_2px_2px_0px_0px_rgba(0,0,0,0.1)] translate-y-[1px]";

const ctaButtonClass =
  "h-9 px-4 text-xs font-black bg-orange-100 text-black border-2 border-black hover:bg-orange-200 shadow-[2px_2px_0px_0px_rgba(0,0,0,0.2)] hover:shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] transition-all tracking-tight flex items-center gap-2 justify-center rounded cursor-pointer";

interface SQLTextAreaActionBarProps {
  hasFooter: boolean;
  isRemoteRunning: boolean;
  shape: SQLTextAreaShape;
  onCancel: () => void;
  onChainQuery: () => void;
  onCreateChart: () => void;
  onRun: () => void;
  onToggleTable: () => void;
}

export function SQLTextAreaActionBar({
  hasFooter,
  isRemoteRunning,
  shape,
  onCancel,
  onChainQuery,
  onCreateChart,
  onRun,
  onToggleTable,
}: SQLTextAreaActionBarProps) {
  const runOrCancel = () => {
    if (shape.props.isRunning) {
      onCancel();
    } else {
      onRun();
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        alignItems: "center",
        padding: 8,
        backgroundColor: "#f3f4f6",
        borderLeft: "4px solid #000",
        gap: 8,
        borderBottomRightRadius: hasFooter ? 0 : 8,
      }}
    >
      <button
        onClick={onCreateChart}
        onPointerDown={(event) => {
          event.stopPropagation();
          if (event.pointerType === "touch") onCreateChart();
        }}
        className={`${buttonBaseClass} ${buttonShadowClass}`}
        style={{
          width: "100%",
          justifyContent: "center",
          touchAction: "none",
          backgroundColor: "#fce7f3", // Pink match (ChartUtil)
        }}
        title="Create Chart"
      >
        <BarChart3 size={16} /> Chart
      </button>

      <button
        onClick={onToggleTable}
        onPointerDown={(event) => {
          event.stopPropagation();
          if (event.pointerType === "touch") onToggleTable();
        }}
        className={`${buttonBaseClass} ${shape.props.showTable ? buttonPressedClass : buttonShadowClass}`}
        style={{
          width: "100%",
          justifyContent: "center",
          touchAction: "none",
          backgroundColor: shape.props.showTable ? "#dcfce7" : "#fff",
        }}
        title={shape.props.showTable ? "Hide Table" : "Show Table"}
      >
        {shape.props.showTable ? (
          <>
            <Eye size={16} /> Table
          </>
        ) : (
          <>
            <EyeOff size={16} /> Table
          </>
        )}
      </button>

      <button
        onClick={onChainQuery}
        onPointerDown={(event) => {
          event.stopPropagation();
          if (event.pointerType === "touch") onChainQuery();
        }}
        className={`${buttonBaseClass} ${buttonShadowClass}`}
        style={{
          width: "100%",
          justifyContent: "center",
          touchAction: "none",
          backgroundColor: "#fef9c3", // Yellow match (Self)
        }}
        title="Chain Query"
      >
        <Search size={16} /> Query
      </button>

      <button
        onClick={runOrCancel}
        onPointerDown={(event) => {
          event.stopPropagation();
          if (event.pointerType === "touch") runOrCancel();
        }}
        className={ctaButtonClass}
        style={{
          width: "100%",
          touchAction: "none",
          opacity: shape.props.isRunning && !isRemoteRunning ? 0.5 : 1,
          cursor: shape.props.isRunning && !isRemoteRunning ? "not-allowed" : "pointer",
        }}
        disabled={shape.props.isRunning && !isRemoteRunning}
        title={shape.props.isRunning ? (isRemoteRunning ? "Cancel Query" : "Query is running locally") : "Run Query"}
      >
        {shape.props.isRunning ? (
          isRemoteRunning ? (
            <>
              <Square size={16} /> Stop
            </>
          ) : (
            <>
              <span className="animate-spin">⏳</span> Running
            </>
          )
        ) : (
          <>
            <Play size={16} /> Run
          </>
        )}
      </button>
    </div>
  );
}
