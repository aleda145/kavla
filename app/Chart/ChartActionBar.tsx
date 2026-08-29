import type { RefObject } from "react";
import ReactECharts from "echarts-for-react";
import { AreaChart, BarChart3, LineChart, ScatterChart } from "lucide-react";
import { ChartExportMenu } from "./ChartExportMenu";
import { ChartSettingsMenu } from "./ChartSettingsMenu";

const CHART_TYPES = [
  { id: "scatter", icon: ScatterChart, label: "Scatter" },
  { id: "line", icon: LineChart, label: "Line" },
  { id: "bar", icon: BarChart3, label: "Bar" },
  { id: "area", icon: AreaChart, label: "Area" },
];

interface ChartActionBarProps {
  chartRef: RefObject<ReactECharts | null>;
  chartType: string;
  fileName: string;
  isStacked: boolean;
  limit: number | null;
  yAxisScale: string;
  onChartTypeChange: (chartType: string) => void;
  onIsStackedChange: (isStacked: boolean) => void;
  onLimitChange: (limit: number | null) => void;
  onYAxisScaleChange: (scale: string) => void;
}

export function ChartActionBar({
  chartRef,
  chartType,
  fileName,
  isStacked,
  limit,
  yAxisScale,
  onChartTypeChange,
  onIsStackedChange,
  onLimitChange,
  onYAxisScaleChange,
}: ChartActionBarProps) {
  return (
    <div
      style={{
        width: 48,
        borderLeft: "4px solid #000",
        backgroundColor: "#f3f4f6",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "12px 0",
        gap: 8,
        flexShrink: 0,
      }}
    >
      {CHART_TYPES.map((type) => (
        <button
          key={type.id}
          onClick={() => onChartTypeChange(type.id)}
          onPointerDown={(event) => {
            event.stopPropagation();
            if (event.pointerType === "touch") onChartTypeChange(type.id);
          }}
          title={type.label}
          style={{
            width: 32,
            height: 32,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: chartType === type.id ? "2px solid black" : "2px solid transparent",
            background: chartType === type.id ? "#dbeafe" : "transparent",
            borderRadius: 4,
            cursor: "pointer",
            color: "#000",
          }}
        >
          <type.icon size={20} />
        </button>
      ))}
      <div style={{ flex: 1 }} />
      <ChartSettingsMenu
        chartType={chartType}
        yAxisScale={yAxisScale}
        onYAxisScaleChange={onYAxisScaleChange}
        isStacked={isStacked}
        onIsStackedChange={onIsStackedChange}
        limit={limit}
        onLimitChange={onLimitChange}
      />
      <ChartExportMenu chartRef={chartRef} fileName={fileName} />
    </div>
  );
}
