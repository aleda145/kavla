import type { chartGeometry } from "./geometry";
import type { ChartSelection } from "./selection";
import { memo, useId, type SVGProps } from "react";
import { scaleUtc } from "d3";
import type { XKind } from "./chart-data";

export const ScatterAxes = memo(function ScatterAxes({
  geometry,
  width,
  height,
  xLabel,
  yLabel,
  selections,
  handlersFor,
  focusedId,
  previewId,
  xKind = "number",
  categories = [],
}: {
  geometry: ReturnType<typeof chartGeometry>;
  width: number;
  height: number;
  xLabel: string;
  yLabel: string;
  selections: ChartSelection[];
  handlersFor?: (selection: ChartSelection, index: number) => SVGProps<SVGPolygonElement>;
  focusedId?: string | null;
  previewId?: string;
  xKind?: XKind;
  categories?: { value: number; label: string }[];
}) {
  const clipId = useId();
  const { plot, xScale, yScale } = geometry;
  const bottom = plot.top + plot.height;
  const xTicks = Math.max(2, Math.floor(plot.width / 90));
  const timeScale = scaleUtc().domain(xScale.domain().map((value) => new Date(value)));
  const ticks =
    xKind === "category"
      ? categories.filter((_, i) => i % Math.max(1, Math.ceil(categories.length / xTicks)) === 0).map((c) => c.value)
      : xKind === "time"
        ? timeScale.ticks(xTicks).map(Number)
        : xScale.ticks(xTicks);
  const yTicks = Math.max(2, Math.floor(plot.height / 48));
  const shorten = (label: string, space: number) => {
    const length = Math.max(4, Math.floor(space / 8));
    return label.length > length ? `${label.slice(0, length - 1)}…` : label;
  };
  return (
    <svg
      width={width}
      height={height}
      aria-label={`${yLabel} by ${xLabel}`}
      style={{ position: "absolute", inset: 0, pointerEvents: "none", fontFamily: "Inter, sans-serif", fill: "#000" }}
    >
      <defs>
        <clipPath id={clipId}>
          <rect x={plot.left} y={plot.top} width={plot.width} height={plot.height} />
        </clipPath>
      </defs>
      {selections.map((selection, index) => {
        const { drawingId, polygon, outline } = selection;
        const dragHandlers = handlersFor?.(selection, index);
        return (
          <polygon
            key={drawingId}
            data-chart-drawing={drawingId}
            {...dragHandlers}
            clipPath={`url(#${clipId})`}
            points={polygon
              .map((p) => {
                const q = geometry.fromAnalytical(p);
                return `${q.x},${q.y}`;
              })
              .join(" ")}
            fill="#fde047"
            fillOpacity={previewId === drawingId || focusedId === drawingId ? 0.28 : 0.08}
            fillRule="evenodd"
            stroke={outline?.color ?? "#000"}
            strokeWidth={outline?.width ?? 2}
            strokeOpacity={outline?.opacity ?? 1}
            strokeDasharray={
              outline
                ? outline.dash === "dashed"
                  ? `${outline.width * 3} ${outline.width * 2}`
                  : outline.dash === "dotted"
                    ? `0 ${outline.width * 2}`
                    : undefined
                : "5 4"
            }
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {dragHandlers && <title>Click to select this drawing or drag to move it</title>}
          </polygon>
        );
      })}
      <path
        d={`M${plot.left},${plot.top}V${bottom}H${plot.left + plot.width}`}
        fill="none"
        stroke="#000"
        strokeWidth={3}
        strokeLinejoin="round"
      />
      {ticks.map((t) => {
        const label =
          xKind === "category"
            ? shorten(categories.find((c) => c.value === t)?.label ?? "", plot.width / xTicks)
            : xKind === "time"
              ? timeScale.tickFormat(xTicks)(new Date(t))
              : xScale.tickFormat(xTicks, "~s")(t);
        if (!label) return null;
        return (
          <g key={t}>
            <path d={`M${xScale(t)},${bottom}v5`} stroke="#000" strokeWidth={2} />
            <text x={xScale(t)} y={bottom + 19} textAnchor="middle" fontSize={11} fontWeight={700}>
              {label}
            </text>
          </g>
        );
      })}
      {yScale.ticks(yTicks).map((t) => {
        const label = yScale.tickFormat(yTicks, "~s")(t);
        if (!label) return null;
        return (
          <g key={t}>
            <path d={`M${plot.left - 5},${yScale(t)}h5`} stroke="#000" strokeWidth={2} />
            <text
              x={plot.left - 9}
              y={yScale(t)}
              dominantBaseline="middle"
              textAnchor="end"
              fontSize={11}
              fontWeight={700}
            >
              {label}
            </text>
          </g>
        );
      })}
      <text x={plot.left + plot.width / 2} y={height - 5} fontSize={12} fontWeight={800} textAnchor="middle">
        <title>{xLabel}</title>
        {shorten(xLabel, plot.width)}
      </text>
      <text
        transform={`translate(14,${plot.top + plot.height / 2}) rotate(-90)`}
        fontSize={12}
        fontWeight={800}
        textAnchor="middle"
      >
        <title>{yLabel}</title>
        {shorten(yLabel, plot.height)}
      </text>
    </svg>
  );
});
