import { scaleLinear, scaleLog, line, scaleBand } from "d3";
import { normalize, type Axis, type Point } from "./selection.ts";

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
