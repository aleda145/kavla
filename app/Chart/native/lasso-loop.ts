import type { Point } from "./selection.ts";

// Work in plot pixels so that a wide or tall chart doesn't distort the pen tolerance.
export function lassoLoop(points: Point[], isClosed: boolean): Point[] | null {
  if (points.length < 3) return null;
  const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + distance(points[i - 1], points[i]));
  const length = lengths[lengths.length - 1];
  if (!length) return null;
  const first = points[0],
    last = points[points.length - 1];
  let loop: Point[] | null = null;
  let longest = length * 0.55;
  // Intersect the approach and return strokes. Keep the main loop and discard both loose tails.
  // Measuring the ends by arc length also works when one side has far more pen samples.
  for (let i = 0; i + 1 < points.length && lengths[i] <= length * 0.35; i++) {
    const a = points[i],
      b = points[i + 1];
    const dx = b.x - a.x,
      dy = b.y - a.y;
    for (let j = points.length - 2; j > i + 1 && lengths[j + 1] >= length * 0.65; j--) {
      const c = points[j],
        d = points[j + 1];
      const ex = d.x - c.x,
        ey = d.y - c.y;
      const cross = dx * ey - dy * ex;
      if (!cross) continue;
      const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / cross;
      const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / cross;
      if (t < 0 || t > 1 || u < 0 || u > 1) continue;
      const from = lengths[i] + t * (lengths[i + 1] - lengths[i]);
      const to = lengths[j] + u * (lengths[j + 1] - lengths[j]);
      if (from > length * 0.35 || to < length * 0.65 || to - from <= longest) continue;
      longest = to - from;
      loop = [{ x: a.x + t * dx, y: a.y + t * dy }, ...points.slice(i + 1, j + 1)];
    }
  }
  if (!loop) {
    const tolerance = Math.min(36, Math.max(12, length * 0.06));
    if (isClosed || distance(first, last) <= tolerance) {
      loop = points;
    } else {
      // A rounded pen tip can appear to touch the opposite stroke without its centreline crossing it.
      let closest = Math.min(tolerance, length * 0.15);
      for (let i = 0; i + 1 < points.length; i++) {
        const approach = lengths[i] <= length * 0.35;
        if (!approach && lengths[i + 1] < length * 0.65) continue;
        const tip = approach ? last : first;
        const a = points[i],
          b = points[i + 1];
        const dx = b.x - a.x,
          dy = b.y - a.y;
        const squared = dx * dx + dy * dy;
        if (!squared) continue;
        const t = Math.max(0, Math.min(1, ((tip.x - a.x) * dx + (tip.y - a.y) * dy) / squared));
        const along = lengths[i] + t * (lengths[i + 1] - lengths[i]);
        if (approach ? along > length * 0.35 : along < length * 0.65) continue;
        const joint = { x: a.x + t * dx, y: a.y + t * dy };
        const gap = distance(tip, joint);
        if (gap >= closest) continue;
        closest = gap;
        loop = approach ? [joint, ...points.slice(i + 1)] : [...points.slice(0, i + 1), joint];
      }
    }
  }
  // Preserve the existing stored-polygon limit for densely sampled freehand circles.
  if (loop && loop.length > 512) {
    const dense = loop;
    return Array.from({ length: 512 }, (_, i) => dense[Math.round((i * (dense.length - 1)) / 511)]);
  }
  return loop;
}
