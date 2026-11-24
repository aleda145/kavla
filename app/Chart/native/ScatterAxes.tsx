import { resizeHandles, selectionBounds, type chartGeometry, type ResizeHandle } from "./geometry";
import type { ChartSelection } from "./selection";
import { memo, useId, type SVGAttributes } from "react";
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
  handlersFor?: (selection: ChartSelection, index: number, handle?: ResizeHandle) => SVGAttributes<SVGGraphicsElement>;
  focusedId?: string | null;
  previewId?: string;
  xKind?: XKind;
  categories?: { value: number; label: string }[];
}) {
  const clipId = useId();
  const { plot, xScale, yScale } = geometry;
  const focusedIndex = selections.findIndex((selection) => selection.drawingId === focusedId);
  const focused = selections[focusedIndex];
  const bounds = focused && selectionBounds(focused.polygon);
  const nw = bounds && geometry.fromAnalytical({ x: bounds.left, y: bounds.top });
  const se = bounds && geometry.fromAnalytical({ x: bounds.right, y: bounds.bottom });
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
        const outlinePath =
          polygon
            .map((p, i) => {
              const { x, y } = geometry.fromAnalytical(p);
              return `${i ? "L" : "M"}${x},${y}`;
            })
            .join(" ") + "Z";
        const frame = selection.inverted
          ? `M${plot.left},${plot.top}h${plot.width}v${plot.height}h${-plot.width}Z`
          : "";
        return (
          <path
            key={drawingId}
            data-chart-drawing={drawingId}
            {...dragHandlers}
            clipPath={`url(#${clipId})`}
            d={frame + outlinePath}
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
          </path>
        );
      })}
      {selections.map(({ drawingId, groupName, polygon }) => {
        if (!groupName) return null;
        const bounds = selectionBounds(polygon);
        const anchor = geometry.fromAnalytical({ x: (bounds.left + bounds.right) / 2, y: bounds.top });
        return (
          <text
            key={drawingId}
            x={anchor.x}
            y={Math.min(bottom - 2, anchor.y + 14)}
            clipPath={`url(#${clipId})`}
            textAnchor="middle"
            fontSize={12}
            fontWeight={700}
            stroke="white"
            strokeWidth={3}
            paintOrder="stroke"
            pointerEvents="none"
          >
            {groupName}
          </text>
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
      {focused && handlersFor && nw && se && (
        <g data-chart-drawing={focused.drawingId}>
          <rect
            x={nw.x}
            y={nw.y}
            width={se.x - nw.x}
            height={se.y - nw.y}
            fill="none"
            stroke="#475569"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
          {resizeHandles.map((handle) => {
            const west = handle.includes("w"),
              east = handle.includes("e");
            const north = handle.includes("n"),
              south = handle.includes("s");
            // Keep small drawings grabbable between their corner handles.
            if ((!west && !east && se.x - nw.x < 28) || (!north && !south && se.y - nw.y < 28)) return null;
            const cx = west ? nw.x - 3 : east ? se.x + 3 : (nw.x + se.x) / 2;
            const cy = north ? nw.y - 3 : south ? se.y + 3 : (nw.y + se.y) / 2;
            return (
              <g key={handle}>
                <rect x={cx - 4} y={cy - 4} width={8} height={8} fill="white" stroke="black" strokeWidth={1.5} />
                <polygon
                  {...handlersFor(focused, focusedIndex, handle)}
                  data-resize-handle={handle}
                  points={`${cx - 7},${cy - 7} ${cx + 7},${cy - 7} ${cx + 7},${cy + 7} ${cx - 7},${cy + 7}`}
                  fill="transparent"
                >
                  <title>Drag to resize, or use the arrow keys</title>
                </polygon>
              </g>
            );
          })}
        </g>
      )}
    </svg>
  );
});
