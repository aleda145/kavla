import { clipSegment } from "./geometry.ts";
import type { Point } from "./selection.ts";

const corners: Point[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];
const near = (a: number, b: number) => Math.abs(a - b) < 1e-10;
const same = (a: Point, b: Point) => near(a.x, b.x) && near(a.y, b.y);
const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

// Counterclockwise from the bottom left in analytical coordinates (Y increases upwards).
function perimeter(p: Point) {
  if (p.y === 0) return p.x;
  if (p.x === 1) return 1 + p.y;
  if (p.y === 1) return 3 - p.x;
  if (p.x === 0) return 4 - p.y;
  return null;
}

function closeAlongFrame(path: Point[], from: number, to: number) {
  const polygon = [...path];
  const limit = to < from ? to + 4 : to;
  for (let corner = Math.floor(from) + 1; corner < limit; corner++) polygon.push(corners[corner % 4]);
  return polygon;
}

// Allow a stroke to start or stop a few plot pixels short of the frame.
function snapEndpoint(p: Point, width: number, height: number): Point {
  if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return p;
  const distances = [p.y * height, (1 - p.x) * width, (1 - p.y) * height, p.x * width];
  const distance = Math.min(...distances);
  if (distance > 6) return p;
  return [
    { ...p, y: 0 },
    { ...p, x: 1 },
    { ...p, y: 1 },
    { ...p, x: 0 },
  ][distances.indexOf(distance)];
}

function crossesItself(path: Point[]) {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1],
      b = path[i];
    for (let j = 1; j < i - 1; j++) {
      const c = path[j - 1],
        d = path[j];
      if (
        Math.min(a.x, b.x) > Math.max(c.x, d.x) ||
        Math.max(a.x, b.x) < Math.min(c.x, d.x) ||
        Math.min(a.y, b.y) > Math.max(c.y, d.y) ||
        Math.max(a.y, b.y) < Math.min(c.y, d.y)
      )
        continue;
      if (cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0) return true;
    }
  }
  return false;
}

export type SliceSide =
  "Above" | "Below" | "Left" | "Right" | "Upper left" | "Lower right" | "Upper right" | "Lower left";
export type SliceRegion = { label: SliceSide; polygon: Point[] };

export function chartSlice(points: Point[], width: number, height: number): SliceRegion[] | null {
  if (points.length < 2) return null;
  const path: Point[] = [];
  let a = snapEndpoint(points[0], width, height);
  for (let i = 1; i < points.length; i++) {
    const b = i === points.length - 1 ? snapEndpoint(points[i], width, height) : points[i];
    if (same(a, b)) continue;
    const interval = clipSegment(a, b, corners[0], corners[2]);
    if (interval) {
      const clamp = (v: number) => (near(v, 0) ? 0 : near(v, 1) ? 1 : v);
      const at = (t: number) => ({ x: clamp(a.x + t * (b.x - a.x)), y: clamp(a.y + t * (b.y - a.y)) });
      const start = at(interval[0]),
        end = at(interval[1]);
      if (!path.length) path.push(start);
      else if (!same(path[path.length - 1], start) || perimeter(start) !== null) return null;
      if (!same(start, end)) {
        // Long straight strokes only need their endpoints. Keep a reversal as drawn.
        const prev = path.at(-2);
        if (
          prev &&
          Math.abs(cross(prev, start, end)) < 1e-14 &&
          (start.x - prev.x) * (end.x - start.x) + (start.y - prev.y) * (end.y - start.y) > 0
        )
          path.pop();
        path.push(end);
      }
    }
    a = b;
  }
  if (path.length < 2) return null;
  const start = path[0],
    end = path[path.length - 1];
  const from = perimeter(start),
    to = perimeter(end);
  if (from === null || to === null || same(start, end)) return null;
  if (
    (start.x === end.x && (start.x === 0 || start.x === 1)) ||
    (start.y === end.y && (start.y === 0 || start.y === 1))
  )
    return null;
  if (path.length > 512) throw new Error("Draw a shorter slice with at most 512 vertices.");
  if (crossesItself(path)) return null;

  const dx = (end.x - start.x) * width,
    dy = (end.y - start.y) * height;
  let labels: [SliceSide, SliceSide];
  if (Math.abs(dy) < Math.abs(dx) / 2) labels = dx > 0 ? ["Above", "Below"] : ["Below", "Above"];
  else if (Math.abs(dx) < Math.abs(dy) / 2) labels = dy > 0 ? ["Left", "Right"] : ["Right", "Left"];
  else if (dx > 0) labels = dy > 0 ? ["Upper left", "Lower right"] : ["Upper right", "Lower left"];
  else labels = dy > 0 ? ["Lower left", "Upper right"] : ["Lower right", "Upper left"];
  const sides = [
    { label: labels[0], polygon: closeAlongFrame(path, to, from) },
    { label: labels[1], polygon: closeAlongFrame(path.reverse(), from, to) },
  ];
  // Keep the buttons in the same order for both pen directions.
  return ["Below", "Right", "Lower left", "Lower right"].includes(labels[0]) ? sides.reverse() : sides;
}
