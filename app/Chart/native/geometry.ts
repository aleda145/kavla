import { scaleLinear, scaleLog, line, scaleBand } from "d3";
import { containsPoint, normalize, type Axis, type Point } from "./selection.ts";

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

// Fractional index along the drawn path where it first enters the unit plot.
// Test whole segments: a fast stroke can cross the plot between sampled points.
export function firstPlotEntry(points: Point[], closed: boolean): number | null {
  for (let i = 1; i < points.length; i++) {
    const start = points[i - 1],
      end = points[i];
    let enter = 0,
      leave = 1;
    for (const axis of ["x", "y"] as const) {
      const delta = end[axis] - start[axis];
      if (delta === 0) {
        if (start[axis] <= 0 || start[axis] >= 1) leave = 0;
      } else {
        const a = -start[axis] / delta,
          b = (1 - start[axis]) / delta;
        enter = Math.max(enter, Math.min(a, b));
        leave = Math.min(leave, Math.max(a, b));
      }
    }
    if (enter < leave) return i - 1 + enter;
  }
  // A loop can surround the whole plot without crossing its interior.
  return closed && containsPoint({ x: 0.5, y: 0.5 }, points) ? points.length : null;
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
