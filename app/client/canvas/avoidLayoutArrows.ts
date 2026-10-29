import { Arc2d, Vec, getArrowInfo, type Editor, type TLArrowShape, type TLShapeId } from "tldraw";

type Point = { x: number; y: number };
type Bounds = Point & { w: number; h: number };
type Route = { id: TLShapeId; ends: Set<TLShapeId>; points: Point[] };
const arrowGap = 20;
const nodeGap = 24;

function hitsBox(a: Point, b: Point, box: Bounds, padding: number): boolean {
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

function readRoute(editor: Editor, id: TLShapeId): Route | undefined {
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

function crosses(route: Route, id: TLShapeId, box: Bounds): boolean {
  // An arrow meeting its own node is a connection, not an obstruction.
  return (
    !route.ends.has(id) && route.points.some((point, i) => i > 0 && hitsBox(route.points[i - 1], point, box, arrowGap))
  );
}

// Run after ELK's positions are applied, in the same undo step. Use tldraw's
// actual routes, without changing bindings or imposing particular arrow sides.
export function avoidLayoutArrows(editor: Editor, queryByView: Map<TLShapeId, TLShapeId>): void {
  const shapes = editor.getCurrentPageShapes();
  const arrowIds = shapes.filter((shape) => shape.type === "arrow").map((shape) => shape.id);
  if (!arrowIds.length) return;

  // Two bounded passes let a view use space freed by a preceding move.
  for (let pass = 0; pass < 2; pass++) {
    let moved = false;
    for (const [viewId, queryId] of queryByView) {
      const view = editor.getShape(viewId);
      const box = editor.getShapePageBounds(viewId);
      const query = editor.getShapePageBounds(queryId);
      if (!view || !box || !query || editor.isShapeOrAncestorLocked(view)) continue;
      const routes = arrowIds.flatMap((id) => {
        const route = readRoute(editor, id);
        return route ? [route] : [];
      });
      const blocking = routes.filter((route) => crosses(route, viewId, box));
      if (!blocking.length) continue;

      const obstacles = shapes.flatMap((shape) => {
        if (shape.id === viewId || shape.type === "arrow" || editor.hasAncestor(view, shape.id)) return [];
        const bounds = editor.getShapePageBounds(shape.id);
        return bounds ? [{ id: shape.id, box: bounds }] : [];
      });
      const overlapsNode = (candidate: Bounds) =>
        obstacles.some(
          ({ box: other }) =>
            candidate.x < other.x + other.w + nodeGap &&
            candidate.x + candidate.w + nodeGap > other.x &&
            candidate.y < other.y + other.h + nodeGap &&
            candidate.y + candidate.h + nodeGap > other.y
        );
      const attached = routes.filter((route) => route.ends.has(viewId));
      const crossings = (candidate: Bounds, connected: Route[]) => {
        const result = new Set<string>();
        for (const route of routes) {
          if (crosses(route, viewId, candidate)) result.add(JSON.stringify([route.id, viewId]));
        }
        for (const route of connected) {
          for (const obstacle of obstacles) {
            if (crosses(route, obstacle.id, obstacle.box)) result.add(JSON.stringify([route.id, obstacle.id]));
          }
        }
        return result;
      };
      const baseline = crossings(box, attached);
      const xs = new Set([query.x - box.w - 40, query.x + query.w + 40]);
      for (const route of blocking) {
        for (let i = 1; i < route.points.length; i++) {
          const a = route.points[i - 1];
          const b = route.points[i];
          if (!hitsBox(a, b, box, arrowGap)) continue;
          xs.add(Math.min(a.x, b.x) - box.w - arrowGap - 1);
          xs.add(Math.max(a.x, b.x) + arrowGap + 1);
        }
      }
      // First slide within the existing chart/table row. Fall back to beside
      // the query, but keep the search local so views remain near their owner.
      const candidates = [...xs]
        .flatMap((x) => [
          { x, y: box.y },
          { x, y: query.y + (query.h - box.h) / 2 },
        ])
        .filter((point) => Math.abs(point.x - box.x) <= box.w + query.w + 80)
        .sort(
          (a, b) =>
            Math.abs(a.x - box.x) + 2 * Math.abs(a.y - box.y) - (Math.abs(b.x - box.x) + 2 * Math.abs(b.y - box.y))
        )
        .slice(0, 16);

      const origin = editor.getShapePageTransform(view).applyToPoint({ x: 0, y: 0 });
      // Preserve annotations and other children at their existing page positions.
      const children = editor.getSortedChildIdsForParent(view.id).map((id) => editor.getShape(id)!);
      const originals = [view, ...children].map((shape) => ({
        id: shape.id,
        type: shape.type,
        x: shape.x,
        y: shape.y,
      }));
      for (const point of candidates) {
        const candidate = { ...point, w: box.w, h: box.h };
        if (overlapsNode(candidate)) continue;
        if (crossings(candidate, attached).size >= baseline.size) continue;
        const dx = point.x - box.x;
        const dy = point.y - box.y;
        const position = editor.getPointInParentSpace(view, { x: origin.x + dx, y: origin.y + dy });
        const childUpdates = children.map((child) => {
          const childOrigin = editor.getShapePageTransform(child).applyToPoint({ x: 0, y: 0 });
          const local = editor.getPointInParentSpace(child, { x: childOrigin.x - dx, y: childOrigin.y - dy });
          return { id: child.id, type: child.type, x: local.x, y: local.y };
        });
        editor.updateShapes([{ id: view.id, type: view.type, x: position.x, y: position.y }, ...childUpdates]);
        // Moving a view also reroutes its own connectors. Reject a candidate if
        // any of those now cross a previously unobstructed node.
        const rerouted = attached.flatMap((route) => {
          const next = readRoute(editor, route.id);
          return next ? [next] : [];
        });
        const after = crossings(candidate, rerouted);
        if (after.size < baseline.size && [...after].every((key) => baseline.has(key))) {
          moved = true;
          break;
        }
        editor.updateShapes(originals);
      }
    }
    if (!moved) break;
  }
}
