import { memo, useEffect, useId, useMemo, useRef } from "react";
import { containsPoint, type Point } from "./selection";
import type { chartGeometry } from "./geometry";
import type { ScatterPlan } from "./planner";
import { densityScale, pointStyle } from "./appearance";

export type Mark = Point & { count: number };
export const ScatterMarks = memo(function ScatterMarks({
  marks,
  geometry,
  plan,
  polygon,
  width,
  height,
  renderer,
  pixelRatio = 1,
}: {
  marks: Mark[];
  geometry: ReturnType<typeof chartGeometry>;
  plan: ScatterPlan;
  polygon: Point[] | null;
  width: number;
  height: number;
  renderer: "svg" | "canvas";
  pixelRatio?: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const clipId = useId();
  const maximum = useMemo(() => marks.reduce((max, mark) => Math.max(max, mark.count), 1), [marks]);
  const color = useMemo(() => densityScale(maximum), [maximum]);
  const selectedColor = useMemo(() => densityScale(maximum, true), [maximum]);
  const point = pointStyle(marks.length);
  useEffect(() => {
    if (renderer !== "canvas" || !canvas.current) return;
    const dpr = Math.min(4, (window.devicePixelRatio || 1) * Math.max(1, pixelRatio));
    const node = canvas.current;
    node.width = Math.ceil(width * dpr);
    node.height = Math.ceil(height * dpr);
    const ctx = node.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is unavailable. Switch to the standard chart in settings.");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    const { plot } = geometry;
    ctx.beginPath();
    ctx.rect(
      plot.left - point.radius,
      plot.top - point.radius,
      plot.width + point.radius * 2,
      plot.height + point.radius * 2
    );
    ctx.clip();
    for (const mark of marks) {
      const p = geometry.fromAnalytical(mark);
      const selected = polygon && containsPoint(mark, polygon);
      if (plan.mode === "density") {
        ctx.fillStyle = (selected ? selectedColor : color)(mark.count);
        const cellWidth = plot.width / plan.columns,
          cellHeight = plot.height / plan.rows;
        const left = Math.round((p.x - cellWidth / 2) * dpr) / dpr;
        const top = Math.round((p.y - cellHeight / 2) * dpr) / dpr;
        const right = Math.round((p.x + cellWidth / 2) * dpr) / dpr;
        const bottom = Math.round((p.y + cellHeight / 2) * dpr) / dpr;
        ctx.fillRect(left, top, right - left, bottom - top);
      } else {
        ctx.fillStyle = selected ? "#fde047" : "#3b82f6";
        ctx.globalAlpha = polygon && !selected ? 0.3 : 1;
        ctx.strokeStyle = "#000";
        ctx.lineWidth = point.stroke;
        ctx.beginPath();
        ctx.arc(p.x, p.y, point.radius, 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();
      }
    }
  }, [
    marks,
    geometry,
    plan,
    polygon,
    width,
    height,
    renderer,
    pixelRatio,
    color,
    selectedColor,
    point.radius,
    point.stroke,
  ]);
  if (renderer === "canvas")
    return <canvas ref={canvas} style={{ position: "absolute", inset: 0, width, height, pointerEvents: "none" }} />;
  return (
    <svg width={width} height={height} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <defs>
        <clipPath id={clipId}>
          <rect
            x={geometry.plot.left - point.radius}
            y={geometry.plot.top - point.radius}
            width={geometry.plot.width + point.radius * 2}
            height={geometry.plot.height + point.radius * 2}
          />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        {marks.map((mark, i) => {
          const p = geometry.fromAnalytical(mark);
          const selected = polygon && containsPoint(mark, polygon);
          return plan.mode === "density" ? (
            <rect
              key={i}
              shapeRendering="crispEdges"
              x={p.x - geometry.plot.width / plan.columns / 2}
              y={p.y - geometry.plot.height / plan.rows / 2}
              width={geometry.plot.width / plan.columns}
              height={geometry.plot.height / plan.rows}
              fill={(selected ? selectedColor : color)(mark.count)}
            />
          ) : (
            <circle
              key={i}
              cx={p.x}
              cy={p.y}
              r={point.radius}
              fill={selected ? "#fde047" : "#3b82f6"}
              stroke="#000"
              strokeWidth={point.stroke}
              opacity={polygon && !selected ? 0.3 : 1}
            />
          );
        })}
      </g>
    </svg>
  );
});
