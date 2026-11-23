import { scaleLinear, scaleLog, line, scaleBand } from "d3";
import { containsPoint, normalize, type Axis, type BarKey, type Point, type SeriesSelection } from "./selection.ts";
import type { Mark } from "./ScatterMarks";
import type { ChartData } from "./chart-data";
import { groupColor } from "./appearance.ts";

export function drawingToPlotPoints(
  points: Point[],
  drawingToPage: (point: Point) => Point,
  pageToChart: (point: Point) => Point,
  plotOffset: Point
): Point[] {
  return points.map((point) => {
    const local = pageToChart(drawingToPage(point));
    return { x: local.x - plotOffset.x, y: local.y - plotOffset.y };
  });
}

// Parameter interval where a segment passes through the rectangle interior.
export function clipSegment(start: Point, end: Point, min: Point, max: Point): [number, number] | null {
  let enter = 0,
    leave = 1;
  for (const axis of ["x", "y"] as const) {
    const delta = end[axis] - start[axis];
    if (delta === 0) {
      if (start[axis] <= min[axis] || start[axis] >= max[axis]) return null;
    } else {
      const a = (min[axis] - start[axis]) / delta;
      const b = (max[axis] - start[axis]) / delta;
      enter = Math.max(enter, Math.min(a, b));
      leave = Math.min(leave, Math.max(a, b));
    }
  }
  return enter < leave ? [enter, leave] : null;
}

// Fractional index along the drawn path where it first enters the rectangle.
// Test whole segments: a fast stroke can cross the plot between sampled points.
export function firstPlotEntry(
  points: Point[],
  closed: boolean,
  min: Point = { x: 0, y: 0 },
  max: Point = { x: 1, y: 1 }
): number | null {
  for (let i = 1; i < points.length; i++) {
    const interval = clipSegment(points[i - 1], points[i], min, max);
    if (interval) return i - 1 + interval[0];
  }
  // A loop can surround the whole plot without crossing its interior.
  return closed && containsPoint({ x: (min.x + max.x) / 2, y: (min.y + max.y) / 2 }, points) ? points.length : null;
}

export function chartGeometry(width: number, height: number, x: Axis, y: Axis) {
  const plot = { left: 66, top: 18, width: Math.max(1, width - 90), height: Math.max(1, height - 64) };
  const scale = (axis: Axis, range: [number, number]) =>
    (axis.type === "log" ? scaleLog() : scaleLinear()).domain(axis.domain).range(range);
  const xScale = scale(x, [plot.left, plot.left + plot.width]);
  const yScale = scale(y, [plot.top + plot.height, plot.top]);
  return {
    plot,
    xScale,
    yScale,
    project: (p: Point) => ({ x: xScale(p.x), y: yScale(p.y) }),
    unproject: (p: Point) => ({ x: xScale.invert(p.x), y: yScale.invert(p.y) }),
    toAnalytical: (p: Point) => ({ x: (p.x - plot.left) / plot.width, y: 1 - (p.y - plot.top) / plot.height }),
    fromAnalytical: (p: Point) => ({ x: plot.left + p.x * plot.width, y: plot.top + (1 - p.y) * plot.height }),
    normalize: (p: Point) => ({ x: normalize(p.x, x), y: normalize(p.y, y) }),
  };
}

export function translateSelection(
  polygon: Point[],
  start: Point,
  end: Point,
  plot: { width: number; height: number }
): Point[] | null {
  // Leave enough of the grabbed region inside the plot to pick it up again.
  function delta(from: number, to: number, size: number) {
    const inset = Math.min(0.5, 4 / size);
    return Math.max(Math.min(from, inset), Math.min(Math.max(from, 1 - inset), to)) - from;
  }
  const dx = delta(start.x, end.x, plot.width);
  const dy = delta(start.y, end.y, plot.height);
  return dx || dy ? polygon.map(({ x, y }) => ({ x: x + dx, y: y + dy })) : null;
}

export type BarRect = { mark: Mark; x: number; y: number; width: number; height: number; color: string };
export function barRectangles(data: ChartData, geometry: ReturnType<typeof chartGeometry>): BarRect[] {
  if (data.kind !== "bar") return [];
  const bandwidth = (geometry.plot.width / Math.max(1, data.categories.length)) * 0.78;
  const groups = data.groups.length || 1;
  const width = bandwidth / (data.stacked ? 1 : groups);
  return data.marks.map((mark) => {
    const point = geometry.fromAnalytical(mark);
    const base = geometry.fromAnalytical({ x: mark.x, y: mark.y0 ?? 0 }).y;
    return {
      mark,
      x: point.x - bandwidth / 2 + (data.stacked ? 0 : Math.max(0, data.groups.indexOf(mark.group ?? null))) * width,
      y: Math.min(point.y, base),
      width: Math.max(0.5, width - (data.stacked ? 0 : 1)),
      height: Math.abs(point.y - base),
      color: data.groups.length ? groupColor(mark.group) : "#3b82f6",
    };
  });
}

export function hitBarKeys(data: ChartData, geometry: ReturnType<typeof chartGeometry>, polygon: Point[]): BarKey[] {
  const path = [...polygon, polygon[0]].map(geometry.fromAnalytical);
  const { plot } = geometry;
  const keys: BarKey[] = [];
  for (const bar of barRectangles(data, geometry)) {
    const min = { x: Math.max(plot.left, bar.x), y: Math.max(plot.top, bar.y) };
    const max = {
      x: Math.min(plot.left + plot.width, bar.x + bar.width),
      y: Math.min(plot.top + plot.height, bar.y + bar.height),
    };
    if (max.x > min.x && max.y > min.y && firstPlotEntry(path, true, min, max) !== null)
      keys.push([bar.mark.xValue ?? null, bar.mark.group ?? null]);
  }
  return keys;
}

// Drawing and moving an outline both bind it to the currently plotted axes and category page.
export function selectionRegion(
  data: ChartData,
  geometry: ReturnType<typeof chartGeometry>,
  polygon: Point[],
  color: string | null
) {
  const region = { x: data.x, y: data.y, polygon };
  let series: SeriesSelection;
  if (data.kind === "bar") {
    series = { kind: "bar", color, stacked: data.stacked, keys: hitBarKeys(data, geometry, polygon) };
  } else if (data.kind === "line" || data.kind === "scatter") {
    if (data.kind === "scatter" && data.xKind === "number")
      return { ...region, version: 1 as const, series: undefined };
    series =
      data.xKind === "category"
        ? { kind: data.kind, xKind: "category", categories: data.categories.map((category) => category.key) }
        : { kind: data.kind, xKind: data.xKind };
  } else {
    throw new Error("This chart does not support selections.");
  }
  return { ...region, version: 2 as const, series };
}

// Shared geometry prototypes. Line and thin-line select plotted observations;
// segment intersections do not imply selecting observations between endpoints.
export function linePath(points: (Point | null)[], project: (p: Point) => Point) {
  return line<Point | null>()
    .defined((p): p is Point => p !== null && Number.isFinite(p.x) && Number.isFinite(p.y))
    .x((p) => project(p!).x)
    .y((p) => project(p!).y)(points);
}

export function barBands(categories: string[], width: number) {
  return scaleBand<string>().domain(categories).range([0, width]).padding(0.15);
}
