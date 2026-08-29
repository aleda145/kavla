import type { ComponentProps, RefObject } from "react";
import ReactECharts from "echarts-for-react";
import type { HeuristicResult } from "./chart-heuristics";

interface ChartBodyProps {
  chartOpts: ComponentProps<typeof ReactECharts>["opts"];
  chartRef: RefObject<ReactECharts | null>;
  chartStyle: ComponentProps<typeof ReactECharts>["style"];
  dataCount: number;
  hasResetColumns: boolean;
  hasSource: boolean;
  isLoading: boolean;
  localError: string | null;
  option: ComponentProps<typeof ReactECharts>["option"];
  resolvedLimit: number;
  showWarning: boolean;
  suggestedOptions: HeuristicResult | null;
  x: string | null;
  y: string | null;
  onApplySuggestedOptions: () => void;
}

export function ChartBody({
  chartOpts,
  chartRef,
  chartStyle,
  dataCount,
  hasResetColumns,
  hasSource,
  isLoading,
  localError,
  option,
  resolvedLimit,
  showWarning,
  suggestedOptions,
  x,
  y,
  onApplySuggestedOptions,
}: ChartBodyProps) {
  const showEmptyState = dataCount === 0 || isLoading || (dataCount > 0 && (!x || !y));

  return (
    <div
      style={{
        flex: 1,
        position: "relative",
        minHeight: 0,
        minWidth: 0,
        padding: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {showEmptyState && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            textAlign: "center",
            color: "#666",
            zIndex: 10,
          }}
        >
          {isLoading ? (
            <span style={{ fontWeight: "bold" }}>Loading data...</span>
          ) : (
            <div>
              {localError ? (
                `Error: ${localError}`
              ) : dataCount > 0 && (!x || !y) ? (
                suggestedOptions && !hasResetColumns ? (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 16,
                      alignItems: "center",
                      maxWidth: 280,
                    }}
                  >
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span style={{ fontWeight: "black", fontSize: 18, color: "#000" }}>Auto Chart?</span>
                    </div>

                    <div
                      style={{
                        fontSize: 12,
                        backgroundColor: "#f9fafb",
                        border: "2px solid #e5e7eb",
                        borderRadius: 6,
                        padding: "8px 12px",
                        display: "flex",
                        flexDirection: "column",
                        gap: 4,
                        width: "100%",
                        textAlign: "left",
                      }}
                    >
                      <div>
                        <span style={{ color: "#888", display: "inline-block", width: 44 }}>Type:</span>{" "}
                        <strong style={{ color: "#000", textTransform: "capitalize" }}>
                          {suggestedOptions.chartType}
                        </strong>
                      </div>
                      <div>
                        <span style={{ color: "#888", display: "inline-block", width: 44 }}>X-Axis:</span>{" "}
                        <strong style={{ color: "#000" }}>{suggestedOptions.x}</strong>
                      </div>
                      <div>
                        <span style={{ color: "#888", display: "inline-block", width: 44 }}>Y-Axis:</span>{" "}
                        <strong style={{ color: "#000" }}>{suggestedOptions.y}</strong>
                      </div>
                      {suggestedOptions.color && (
                        <div>
                          <span style={{ color: "#888", display: "inline-block", width: 44 }}>Color:</span>{" "}
                          <strong style={{ color: "#000" }}>{suggestedOptions.color}</strong>
                        </div>
                      )}
                    </div>
                    <button
                      className="group"
                      onClick={onApplySuggestedOptions}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        if (event.pointerType === "touch") {
                          onApplySuggestedOptions();
                        }
                      }}
                      style={{
                        padding: "0 16px",
                        height: 36,
                        backgroundColor: "#fbcfe8", // Pink-200 (one step deeper than Pink-100 header)
                        color: "black",
                        border: "2px solid #000",
                        borderRadius: 4,
                        fontWeight: "bold",
                        fontSize: 13,
                        cursor: "pointer",
                        boxShadow: "2px 2px 0px 0px rgba(0,0,0,0.2)",
                        transition: "all 0.15s ease",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 8,
                      }}
                      onMouseOver={(event) => {
                        event.currentTarget.style.boxShadow = "3px 3px 0px 0px rgba(0,0,0,1)";
                        event.currentTarget.style.transform = "translate(-1px, -1px)";
                      }}
                      onMouseOut={(event) => {
                        event.currentTarget.style.boxShadow = "2px 2px 0px 0px rgba(0,0,0,0.2)";
                        event.currentTarget.style.transform = "translate(0px, 0px)";
                      }}
                      onMouseDown={(event) => {
                        event.currentTarget.style.transform = "translate(1px, 1px)";
                        event.currentTarget.style.boxShadow = "1px 1px 0px 0px rgba(0,0,0,1)";
                      }}
                      onMouseUp={(event) => {
                        event.currentTarget.style.transform = "translate(-1px, -1px)";
                        event.currentTarget.style.boxShadow = "3px 3px 0px 0px rgba(0,0,0,1)";
                      }}
                    >
                      Looks Good to Me
                    </button>
                  </div>
                ) : hasResetColumns ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center" }}>
                    <span style={{ fontWeight: "bold", fontSize: 16, color: "#9f1239" }}>Broken chart 💔</span>
                    <span style={{ fontSize: 14 }}>
                      The upstream data changed and the columns you selected are no longer there. Please select new ones
                      below!
                    </span>
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center" }}>
                    <span style={{ fontWeight: "bold", fontSize: 16, color: "#000" }}>Almost there!</span>
                    <span style={{ fontSize: 14 }}>Select X and Y columns below to generate the chart.</span>
                  </div>
                )
              ) : !hasSource ? (
                "Drop a data source on this chart to configure axes."
              ) : (
                "No rows returned"
              )}
            </div>
          )}
        </div>
      )}

      <div style={{ flex: 1, position: "relative", overflow: "hidden", minHeight: 0, minWidth: 0 }}>
        {dataCount > 0 && x && y && (
          <div style={{ position: "absolute", top: 8, bottom: 8, left: 8, right: 8 }}>
            <ReactECharts ref={chartRef} option={option} style={chartStyle} opts={chartOpts} notMerge={true} />
          </div>
        )}
      </div>

      {showWarning && (
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            background: "#fffbe6",
            padding: "4px 8px",
            color: "#92400e",
            fontSize: 10,
            borderTop: "2px solid #000",
            fontWeight: "bold",
            zIndex: 20,
          }}
        >
          Limiting the chart to {resolvedLimit.toLocaleString()} points. Consider aggregating your data.
        </div>
      )}
    </div>
  );
}
