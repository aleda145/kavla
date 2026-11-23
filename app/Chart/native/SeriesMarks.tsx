import { area, line } from "d3";
import { memo, useEffect, useId, useMemo, useRef } from "react";
import { groupColor } from "./appearance";
import { barRectangles, type chartGeometry } from "./geometry";
import { selectsPoint, type ChartSelection } from "./selection";
import type { ChartData } from "./chart-data";
import type { Mark } from "./ScatterMarks";

export const SeriesMarks = memo(function SeriesMarks({
  data,
  geometry,
  width,
  height,
  renderer,
  pixelRatio = 1,
  selections,
}: {
  data: ChartData;
  geometry: ReturnType<typeof chartGeometry>;
  width: number;
  height: number;
  renderer: "svg" | "canvas";
  pixelRatio?: number;
  selections: ChartSelection[];
}) {
  const id = useId(),
    canvas = useRef<HTMLCanvasElement>(null);
  const bars = useMemo(() => barRectangles(data, geometry), [data, geometry]);
  const selected = useMemo(() => {
    if (!selections.length) return null;
    if (data.kind === "bar") {
      const keys = new Set<string>();
      for (const { series } of selections) {
        if (series?.kind === "bar") for (const key of series.keys) keys.add(JSON.stringify(key));
      }
      return new Set(data.marks.filter((m) => keys.has(JSON.stringify([m.xValue, m.group]))));
    }
    return new Set(data.marks.filter((m) => selections.some((r) => selectsPoint(m, r))));
  }, [data, selections]);
  const runs = useMemo(() => {
    const groups = new Map<string, Mark[]>();
    for (const mark of data.marks) {
      const key = JSON.stringify([mark.group, mark.run]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(mark);
    }
    const stroke = line<Mark>()
      .x((p) => geometry.fromAnalytical(p).x)
      .y((p) => geometry.fromAnalytical(p).y);
    const fill = area<Mark>()
      .x((p) => geometry.fromAnalytical(p).x)
      .y1((p) => geometry.fromAnalytical(p).y)
      .y0((p) => geometry.fromAnalytical({ x: p.x, y: p.y0 ?? 0 }).y);
    return [...groups.values()].map((marks) => ({
      marks,
      line: stroke(marks) ?? "",
      area: fill(marks) ?? "",
      color: data.groups.length ? groupColor(marks[0].group) : "#3b82f6",
    }));
  }, [data, geometry]);
  const symbols = data.marks.length <= 200;
  useEffect(() => {
    if (renderer !== "canvas" || !canvas.current) return;
    const ratio = Math.min(4, (window.devicePixelRatio || 1) * Math.max(1, pixelRatio));
    canvas.current.width = Math.ceil(width * ratio);
    canvas.current.height = Math.ceil(height * ratio);
    const ctx = canvas.current.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is unavailable.");
    ctx.scale(ratio, ratio);
    ctx.beginPath();
    ctx.rect(geometry.plot.left, geometry.plot.top, geometry.plot.width, geometry.plot.height);
    ctx.clip();
    if (data.kind === "bar") {
      for (const bar of bars) {
        ctx.fillStyle = selected?.has(bar.mark) ? "#fde047" : bar.color;
        ctx.fillRect(bar.x, bar.y, bar.width, bar.height);
      }
      return;
    }
    for (const run of runs) {
      if (data.kind === "area") {
        ctx.fillStyle = run.color;
        ctx.globalAlpha = data.stacked ? 0.75 : 0.25;
        ctx.fill(new Path2D(run.area));
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = run.color;
      ctx.lineWidth = 3.5;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke(new Path2D(run.line));
      if (!symbols && run.marks.length > 1 && !selected?.size) continue;
      for (const mark of run.marks) {
        if (!symbols && run.marks.length > 1 && !selected?.has(mark)) continue;
        const p = geometry.fromAnalytical(mark);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3.5, 0, 2 * Math.PI);
        ctx.fillStyle = selected?.has(mark) ? "#fde047" : run.color;
        ctx.fill();
        ctx.strokeStyle = "#000";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }, [renderer, width, height, pixelRatio, geometry, data, bars, runs, symbols, selected]);
  if (renderer === "canvas")
    return <canvas ref={canvas} style={{ position: "absolute", inset: 0, width, height, pointerEvents: "none" }} />;
  return (
    <svg width={width} height={height} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <defs>
        <clipPath id={id}>
          <rect
            x={geometry.plot.left}
            y={geometry.plot.top}
            width={geometry.plot.width}
            height={geometry.plot.height}
          />
        </clipPath>
      </defs>
      <g clipPath={`url(#${id})`}>
        {data.kind === "bar"
          ? bars.map((bar, i) => (
              <rect
                key={i}
                x={bar.x}
                y={bar.y}
                width={bar.width}
                height={bar.height}
                fill={selected?.has(bar.mark) ? "#fde047" : bar.color}
              />
            ))
          : runs.map((run, i) => (
              <g key={i}>
                {data.kind === "area" && <path d={run.area} fill={run.color} opacity={data.stacked ? 0.75 : 0.25} />}
                <path
                  d={run.line}
                  fill="none"
                  stroke={run.color}
                  strokeWidth={3.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {(symbols || run.marks.length === 1 || Boolean(selected?.size)) &&
                  run.marks.map((mark, j) => {
                    if (!symbols && run.marks.length > 1 && !selected?.has(mark)) return null;
                    const p = geometry.fromAnalytical(mark);
                    return (
                      <circle
                        key={j}
                        cx={p.x}
                        cy={p.y}
                        r={3.5}
                        fill={selected?.has(mark) ? "#fde047" : run.color}
                        stroke="#000"
                        strokeWidth={1.5}
                      />
                    );
                  })}
              </g>
            ))}
      </g>
    </svg>
  );
});
