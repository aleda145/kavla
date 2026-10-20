import { memo, useEffect, useRef } from "react";
import { containsPoint, type Point } from "./selection";
import type { chartGeometry } from "./geometry";
import type { ScatterPlan } from "./planner";

export type Mark = Point & { count: number };
export const ScatterMarks = memo(function ScatterMarks({
  marks,
  geometry,
  plan,
  polygon,
  width,
  height,
  renderer,
}: {
  marks: Mark[];
  geometry: ReturnType<typeof chartGeometry>;
  plan: ScatterPlan;
  polygon: Point[] | null;
  width: number;
  height: number;
  renderer: "svg" | "canvas";
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const selected = (mark: Mark) => polygon && containsPoint(mark, polygon);
  useEffect(() => {
    if (renderer !== "canvas" || !canvas.current) return;
    const dpr = window.devicePixelRatio || 1;
    const node = canvas.current;
    node.width = Math.ceil(width * dpr);
    node.height = Math.ceil(height * dpr);
    const ctx = node.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is unavailable. Switch to SVG.");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    for (const mark of marks) {
      const p = geometry.fromAnalytical(mark);
      ctx.fillStyle = selected(mark) ? "#eab308" : "#3b82f6";
      if (plan.mode === "density") {
        ctx.globalAlpha = Math.min(1, 0.2 + Math.log1p(mark.count) / 12);
        ctx.fillRect(
          p.x - geometry.plot.width / plan.columns / 2,
          p.y - geometry.plot.height / plan.rows / 2,
          geometry.plot.width / plan.columns,
          geometry.plot.height / plan.rows
        );
      } else {
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
  }, [marks, geometry, plan, polygon, width, height, renderer]);
  if (renderer === "canvas")
    return <canvas ref={canvas} style={{ position: "absolute", inset: 0, width, height, pointerEvents: "none" }} />;
  return (
    <svg width={width} height={height} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {marks.map((mark, i) => {
        const p = geometry.fromAnalytical(mark);
        return plan.mode === "density" ? (
          <rect
            key={i}
            x={p.x - geometry.plot.width / plan.columns / 2}
            y={p.y - geometry.plot.height / plan.rows / 2}
            width={geometry.plot.width / plan.columns}
            height={geometry.plot.height / plan.rows}
            fill={selected(mark) ? "#eab308" : "#3b82f6"}
            opacity={Math.min(1, 0.2 + Math.log1p(mark.count) / 12)}
          />
        ) : (
          <circle key={i} cx={p.x} cy={p.y} r={3} fill={selected(mark) ? "#eab308" : "#3b82f6"} />
        );
      })}
    </svg>
  );
});
