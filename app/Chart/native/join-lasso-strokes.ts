import type { Point } from "./selection.ts";
import { limitLassoVertices } from "./lasso-loop.ts";

type Stroke<T> = { drawing: T; points: Point[] };
type Tip = { point: Point; index: number };

const gapTolerance = 12;
const tailLimit = 40;
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// Only join near the ends. Mid-stroke crossings can be unrelated annotations.
function tips(points: Point[], start: number, step: number, reach: number) {
  const tip: Tip[] = [{ point: points[start], index: start }];
  for (let i = start + step; i >= 0 && i < points.length && reach > 0; i += step) {
    const a = points[i - step],
      b = points[i];
    const length = distance(a, b);
    if (!length) continue;
    const t = Math.min(1, reach / length);
    tip.push({ point: { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) }, index: lerp(i - step, i, t) });
    reach -= length;
  }
  return tip;
}

type Joint = { point: Point; exit: number; enter: number; gap: number };
function join(a: Tip[], b: Tip[]): Joint | undefined {
  if (distance(a[0].point, b[0].point) > 2 * tailLimit + gapTolerance) return;
  let best: Joint | undefined;
  for (let i = 1; i < a.length; i++) {
    const p = a[i - 1].point,
      q = a[i].point;
    const dx = q.x - p.x,
      dy = q.y - p.y;
    for (let j = 1; j < b.length; j++) {
      const r = b[j - 1].point,
        s = b[j].point;
      const ex = s.x - r.x,
        ey = s.y - r.y;
      const cross = dx * ey - dy * ex;
      const at = (t: number, u: number): Joint => {
        const x = p.x + t * dx,
          y = p.y + t * dy;
        const xx = r.x + u * ex,
          yy = r.y + u * ey;
        return {
          point: { x: (x + xx) / 2, y: (y + yy) / 2 },
          exit: lerp(a[i - 1].index, a[i].index, t),
          enter: lerp(b[j - 1].index, b[j].index, u),
          gap: Math.hypot(x - xx, y - yy),
        };
      };
      if (cross) {
        const t = ((r.x - p.x) * ey - (r.y - p.y) * ex) / cross;
        const u = ((r.x - p.x) * dy - (r.y - p.y) * dx) / cross;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return at(t, u);
      }
      // Snap a pen tip to the other stroke when the centrelines just miss.
      const clamp = (v: number) => Math.max(0, Math.min(1, v));
      if (i === 1) {
        const hit = at(0, clamp(((p.x - r.x) * ex + (p.y - r.y) * ey) / (ex * ex + ey * ey)));
        if (hit.gap <= gapTolerance && (!best || hit.gap < best.gap)) best = hit;
      }
      if (j === 1) {
        const hit = at(clamp(((r.x - p.x) * dx + (r.y - p.y) * dy) / (dx * dx + dy * dy)), 0);
        if (hit.gap <= gapTolerance && (!best || hit.gap < best.gap)) best = hit;
      }
    }
  }
  return best;
}

function orient<T>(stroke: Stroke<T>, points: Point[]) {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += distance(points[i - 1], points[i]);
  const reach = Math.min(tailLimit, length / 3);
  return {
    drawing: stroke.drawing,
    points,
    head: tips(points, 0, 1, reach),
    tail: tips(points, points.length - 1, -1, reach),
  };
}

// Retracing a curved stroke can join both ends without enclosing any space.
// Check for an interior span under the same even-odd fill used by selected_area.
export function enclosesArea(polygon: Point[], withinPlot = false) {
  const levels = new Set(polygon.map((p) => p.y).filter((y) => !withinPlot || (y > 0 && y < 1)));
  if (withinPlot) {
    levels.add(0).add(1);
    // A sliver can enter and leave through the side of the plot between two vertex heights.
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i],
        b = polygon[(i + 1) % polygon.length];
      for (const x of [0, 1]) {
        if (a.x > x === b.x > x) continue;
        const y = lerp(a.y, b.y, (x - a.x) / (b.x - a.x));
        if (y > 0 && y < 1) levels.add(y);
      }
    }
  }
  const heights = [...levels].sort((a, b) => a - b);
  for (let i = 1; i < heights.length; i++) {
    for (const t of [1 / 3, 2 / 3]) {
      const y = lerp(heights[i - 1], heights[i], t);
      const crossings: number[] = [];
      for (let j = 0; j < polygon.length; j++) {
        const a = polygon[j],
          b = polygon[(j + 1) % polygon.length];
        if (a.y > y !== b.y > y) crossings.push(lerp(a.x, b.x, (y - a.y) / (b.y - a.y)));
      }
      crossings.sort((a, b) => a - b);
      for (let j = 1; j < crossings.length; j += 2) {
        const left = withinPlot ? Math.max(0, crossings[j - 1]) : crossings[j - 1];
        const right = withinPlot ? Math.min(1, crossings[j]) : crossings[j];
        if (right - left > (withinPlot ? 1e-12 : 1e-6)) return true;
      }
    }
  }
  return false;
}

// Find a closed chain containing the new stroke. A branch which only touches one
// end stays on the canvas. Breadth-first search prefers the fewest contributing strokes.
export function joinLassoStrokes<T>(seed: Stroke<T>, others: Stroke<T>[]) {
  if (seed.points.length < 2 || !others.length) return null;
  const first = orient(seed, seed.points);
  const candidates = others
    .filter((s) => s.points.length >= 2)
    .flatMap((s) => [orient(s, s.points), orient(s, [...s.points].reverse())]);
  type Path = typeof first;
  type Step = { path: Path; previous?: Step; joint?: Joint };
  const pending: Step[] = [{ path: first }];
  const visited = new Set<Path>();
  for (let i = 0; i < pending.length; i++) {
    const step = pending[i];
    const chain: Step[] = [];
    for (let s: Step | undefined = step; s; s = s.previous) chain.push(s);
    if (step.previous) {
      const closure = join(step.path.tail, first.head);
      if (closure) {
        const polygon: Point[] = [];
        const ordered = [...chain].reverse();
        ordered.forEach(({ path, joint }, k) => {
          const incoming = joint ?? closure;
          const outgoing = ordered[k + 1]?.joint ?? closure;
          polygon.push(incoming.point);
          for (let j = Math.floor(incoming.enter) + 1; j < outgoing.exit; j++) polygon.push(path.points[j]);
        });
        const loop = limitLassoVertices(polygon);
        if (enclosesArea(loop)) return { polygon: loop, drawings: ordered.map((s) => s.path.drawing) };
      }
    }
    const used = new Set(chain.map((s) => s.path.drawing));
    const next: Step[] = [];
    for (const path of candidates) {
      if (visited.has(path) || used.has(path.drawing)) continue;
      const joint = join(step.path.tail, path.head);
      if (joint) {
        visited.add(path);
        next.push({ path, joint, previous: step });
      }
    }
    pending.push(...next.sort((a, b) => a.joint!.gap - b.joint!.gap));
  }
  return null;
}
