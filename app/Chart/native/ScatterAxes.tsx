import { cornerHandles, edgeHandles, selectionBounds, type chartGeometry, type SelectionHandle } from "./geometry";
import type { ChartSelection, Point } from "./selection";
import { memo, useId, type SVGAttributes } from "react";
import { scaleUtc } from "d3";
import type { XKind } from "./chart-data";

type DrawingHandlers = (
  selection: ChartSelection,
  index: number,
  handle?: SelectionHandle
) => SVGAttributes<SVGGraphicsElement>;

export const ScatterAxes = memo(function ScatterAxes({
  geometry,
  width,
  height,
  xLabel,
  yLabel,
  selections,
  handlersFor,
  focusedId,
  zoom = 1,
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
  handlersFor?: DrawingHandlers;
  zoom?: number;
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
        <DrawingHandles
          drawing={focused}
          index={focusedIndex}
          handlersFor={handlersFor}
          nw={nw}
          se={se}
          width={width}
          height={height}
          zoom={zoom}
        />
      )}
    </svg>
  );
});

function DrawingHandles({
  drawing,
  index,
  handlersFor,
  nw,
  se,
  width,
  height,
  zoom,
}: {
  drawing: ChartSelection;
  index: number;
  handlersFor: DrawingHandlers;
  nw: Point;
  se: Point;
  width: number;
  height: number;
  zoom: number;
}) {
  const boxWidth = se.x - nw.x;
  const boxHeight = se.y - nw.y;
  const square = Math.min(8 / zoom, boxWidth / 2, boxHeight / 2);
  const cornerHit = 7 / zoom;
  const rotateHit = 18 / zoom;
  // Leave the middle of a small drawing available for moving it.
  const insideX = Math.min(cornerHit, boxWidth / 4);
  const insideY = Math.min(cornerHit, boxHeight / 4);
  return (
    <g data-chart-drawing={drawing.drawingId}>
      <rect className="tl-selection__fg__outline" x={nw.x} y={nw.y} width={boxWidth} height={boxHeight} />
      {edgeHandles.map((edge) => {
        const horizontal = edge === "n" || edge === "s";
        const edgeX = Math.min(4.5 / zoom, insideX);
        const edgeY = Math.min(4.5 / zoom, insideY);
        return (
          <rect
            key={edge}
            {...handlersFor(drawing, index, edge)}
            data-resize-handle={edge}
            x={horizontal ? nw.x + insideX : (edge === "w" ? nw.x : se.x) - edgeX}
            y={horizontal ? (edge === "n" ? nw.y : se.y) - edgeY : nw.y + insideY}
            width={horizontal ? boxWidth - 2 * insideX : 2 * edgeX}
            height={horizontal ? 2 * edgeY : boxHeight - 2 * insideY}
            fill="transparent"
          >
            <title>Drag the edge to resize</title>
          </rect>
        );
      })}
      {cornerHandles.map((corner) => {
        const west = corner.endsWith("w");
        const north = corner.startsWith("n");
        const cx = west ? nw.x : se.x;
        const cy = north ? nw.y : se.y;
        // Even at the chart boundary, reserve some space outside the square for rotation.
        const outsideX = Math.min(cornerHit, (west ? cx : width - cx) / 2);
        const outsideY = Math.min(cornerHit, (north ? cy : height - cy) / 2);
        return (
          <g key={corner}>
            <rect
              {...handlersFor(drawing, index, `rotate-${corner}`)}
              data-rotate-handle={corner}
              x={west ? cx - rotateHit : cx}
              y={north ? cy - rotateHit : cy}
              width={rotateHit}
              height={rotateHit}
              fill="transparent"
            >
              <title>Drag outside the corner to rotate. Hold Shift for 15° steps.</title>
            </rect>
            <rect className="tl-corner-handle" x={cx - square / 2} y={cy - square / 2} width={square} height={square} />
            <rect
              {...handlersFor(drawing, index, corner)}
              data-resize-handle={corner}
              x={cx - (west ? outsideX : insideX)}
              y={cy - (north ? outsideY : insideY)}
              width={outsideX + insideX}
              height={outsideY + insideY}
              fill="transparent"
            >
              <title>Drag the corner to resize, or use the arrow keys</title>
            </rect>
          </g>
        );
      })}
    </g>
  );
}
