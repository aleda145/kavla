import { Arc2d, Vec, getArrowInfo, type Editor, type TLArrowShape, type TLShapeId } from "tldraw";

export type Point = { x: number; y: number };
export type Bounds = Point & { w: number; h: number };
export type Route = { id: TLShapeId; ends: Set<TLShapeId>; points: Point[] };
const arrowGap = 20;

export function hitsBox(a: Point, b: Point, box: Bounds, padding: number): boolean {
  // Clip the segment to the padded rectangle (also handles diagonal arrows).
  let enter = 0;
  let exit = 1;
  for (const axis of ["x", "y"] as const) {
    const min = box[axis] - padding;
    const max = box[axis] + (axis === "x" ? box.w : box.h) + padding;
    const delta = b[axis] - a[axis];
    if (Math.abs(delta) < 0.000001) {
      if (a[axis] < min || a[axis] > max) return false;
    } else {
      const first = (min - a[axis]) / delta;
      const last = (max - a[axis]) / delta;
      enter = Math.max(enter, Math.min(first, last));
      exit = Math.min(exit, Math.max(first, last));
      if (enter > exit) return false;
    }
  }
  return true;
}

export function readRoute(editor: Editor, id: TLShapeId): Route | undefined {
  const arrow = editor.getShape<TLArrowShape>(id);
  if (!arrow) return;
  const info = getArrowInfo(editor, arrow);
  if (!info?.isValid) return;
  const points =
    info.type === "elbow"
      ? info.route.points
      : info.type === "straight"
        ? [info.start.point, info.end.point]
        : new Arc2d({
            center: Vec.Cast(info.handleArc.center),
            start: Vec.Cast(info.start.point),
            end: Vec.Cast(info.end.point),
            sweepFlag: info.bodyArc.sweepFlag,
            largeArcFlag: info.bodyArc.largeArcFlag,
          }).vertices;
  const transform = editor.getShapePageTransform(arrow);
  const ends = new Set<TLShapeId>();
  if (info.bindings.start) ends.add(info.bindings.start.toId);
  if (info.bindings.end) ends.add(info.bindings.end.toId);
  return { id, ends, points: points.map((point) => transform.applyToPoint(point)) };
}

export function crosses(route: Route, id: TLShapeId, box: Bounds): boolean {
  // An arrow meeting its own node is a connection, not an obstruction.
  return (
    !route.ends.has(id) && route.points.some((point, i) => i > 0 && hitsBox(route.points[i - 1], point, box, arrowGap))
  );
}
