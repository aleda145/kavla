import { Arc2d, Vec, getArrowInfo, type Editor, type TLArrowShape, type TLShapeId } from "tldraw";
import type { LayoutDirection } from "./layoutQueryBranches";

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
export function avoidLayoutArrows(
  editor: Editor,
  queryByView: Map<TLShapeId, TLShapeId>,
  nodeIds: Set<TLShapeId>,
  groups: Map<TLShapeId, { direction: LayoutDirection; members: TLShapeId[] }>
): void {
  const shapes = editor.getCurrentPageShapes();
  const arrowIds = shapes.filter((shape) => shape.type === "arrow").map((shape) => shape.id);
  if (!arrowIds.length) return;
  const readRoutes = () =>
    arrowIds.flatMap((id) => {
      const route = readRoute(editor, id);
      return route ? [route] : [];
    });
  // Try the views individually first, then complete query groups. Shared inputs
  // stay put; moving query groups across their flow preserves downstream order.
  const units = [
    ...[...queryByView].map(([id, queryId]) => ({
      id,
      members: [id],
      queryId,
      direction: groups.get(queryId)!.direction,
    })),
    ...[...groups]
      .filter(([id]) => !["data-source", "knob"].includes(editor.getShape(id)!.type))
      .map(([id, group]) => ({ id, ...group, queryId: undefined })),
  ];
  const startingBounds = new Map([...nodeIds].map((id) => [id, editor.getShapePageBounds(id)]));
  // A small, bounded relaxation pass. Always reduce the number of obstructed
  // arrow/node pairs, including connectors rerouted by a candidate move.
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (const unit of units) {
      if (unit.members.some((id) => editor.isShapeOrAncestorLocked(id))) continue;
      const movingIds = new Set(unit.members);
      const boxes = [...nodeIds].flatMap((id) => {
        const box = editor.getShapePageBounds(id);
        return box ? [{ id, box }] : [];
      });
      const moving = boxes.filter(({ id }) => movingIds.has(id));
      const fixed = boxes.filter(({ id }) => !movingIds.has(id));
      const anchor = editor.getShapePageBounds(unit.queryId ?? unit.id);
      const current = editor.getShapePageBounds(unit.id);
      const original = startingBounds.get(unit.id);
      if (!moving.length || !anchor || !current || !original) continue;
      const routes = readRoutes();
      const attachedIds = new Set(
        routes.filter((route) => [...route.ends].some((id) => movingIds.has(id))).map((route) => route.id)
      );
      const unchangedRoutes = routes.filter((route) => !attachedIds.has(route.id));
      const unchangedCrossings = (delta: Point) =>
        moving.reduce(
          (count, { id, box }) =>
            count +
            unchangedRoutes.filter((route) =>
              crosses(route, id, {
                x: box.x + delta.x,
                y: box.y + delta.y,
                w: box.w,
                h: box.h,
              })
            ).length,
          0
        );
      const countCrossings = (delta: Point, paths: Route[]) => {
        let count = 0;
        for (const route of paths) {
          for (const { id, box } of moving) {
            if (crosses(route, id, { ...box, x: box.x + delta.x, y: box.y + delta.y })) count++;
          }
          if (attachedIds.has(route.id)) {
            for (const { id, box } of fixed) {
              if (crosses(route, id, box)) count++;
            }
          }
        }
        return count;
      };
      const baseline = countCrossings({ x: 0, y: 0 }, routes);
      if (!baseline) continue;
      const xs = new Set([0, -80, 80, -160, 160, -320, 320]);
      const ys = new Set(xs);
      for (const { id, box } of moving) {
        for (const route of routes) {
          if (route.ends.has(id)) continue;
          for (let i = 1; i < route.points.length; i++) {
            const a = route.points[i - 1];
            const b = route.points[i];
            if (!hitsBox(a, b, box, arrowGap)) continue;
            xs.add(Math.min(a.x, b.x) - box.w - arrowGap - 1 - box.x);
            xs.add(Math.max(a.x, b.x) + arrowGap + 1 - box.x);
            ys.add(Math.min(a.y, b.y) - box.h - arrowGap - 1 - box.y);
            ys.add(Math.max(a.y, b.y) + arrowGap + 1 - box.y);
          }
        }
        for (const { box: other } of fixed) {
          xs.add(other.x - box.w - nodeGap - box.x);
          xs.add(other.x + other.w + nodeGap - box.x);
          ys.add(other.y - box.h - nodeGap - box.y);
          ys.add(other.y + other.h + nodeGap - box.y);
        }
      }
      const vertical = unit.direction === "DOWN" || unit.direction === "UP";
      const isQueryGroup = editor.getShape(unit.id)!.type === "sql-text-area";
      const nearby = (values: Set<number>) => [...values].sort((a, b) => Math.abs(a) - Math.abs(b)).slice(0, 18);
      const candidates = isQueryGroup
        ? nearby(vertical ? xs : ys).map((value) => (vertical ? { x: value, y: 0 } : { x: 0, y: value }))
        : nearby(xs).flatMap((x) => nearby(ys).map((y) => ({ x, y })));
      const overlapsNode = (delta: Point) =>
        moving.some(({ id, box }) =>
          fixed.some(
            ({ id: otherId, box: other }) =>
              !editor.hasAncestor(id, otherId) &&
              !editor.hasAncestor(otherId, id) &&
              box.x + delta.x < other.x + other.w + nodeGap &&
              box.x + delta.x + box.w + nodeGap > other.x &&
              box.y + delta.y < other.y + other.h + nodeGap &&
              box.y + delta.y + box.h + nodeGap > other.y
          )
        );
      const nearbyCandidates = candidates
        .filter(
          (delta) =>
            (delta.x !== 0 || delta.y !== 0) &&
            Math.abs(current.x + delta.x - original.x) <= anchor.w + current.w + 320 &&
            Math.abs(current.y + delta.y - original.y) <= anchor.h + current.h + 320 &&
            !overlapsNode(delta) &&
            unchangedCrossings(delta) < baseline
        )
        .sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y))
        .slice(0, 64);

      // Countertranslate children outside this unit (including annotations),
      // which follow their final anchor only after all node placement is done.
      const updateIds = new Set(unit.members);
      for (const id of unit.members) {
        for (const child of editor.getSortedChildIdsForParent(id)) updateIds.add(child);
      }
      const originals = [...updateIds].map((id) => {
        const shape = editor.getShape(id)!;
        return { id, type: shape.type, x: shape.x, y: shape.y };
      });
      const updatesFor = (delta: Point) =>
        [...updateIds].map((id) => {
          const shape = editor.getShape(id)!;
          const factor = Number(movingIds.has(id)) - Number(movingIds.has(shape.parentId as TLShapeId));
          const origin = editor.getShapePageTransform(shape).applyToPoint({ x: 0, y: 0 });
          const point = editor.getPointInParentSpace(shape, {
            x: origin.x + factor * delta.x,
            y: origin.y + factor * delta.y,
          });
          return { id, type: shape.type, x: point.x, y: point.y };
        });
      let bestCount = baseline;
      let bestUpdates: ReturnType<typeof updatesFor> | undefined;
      for (const delta of nearbyCandidates) {
        const updates = updatesFor(delta);
        editor.updateShapes(updates);
        const count = countCrossings(delta, readRoutes());
        if (count < bestCount) {
          bestCount = count;
          bestUpdates = updates;
        }
        editor.updateShapes(originals);
        if (bestCount === 0) break;
      }
      if (bestUpdates) {
        editor.updateShapes(bestUpdates);
        moved = true;
      }
    }
    if (!moved) break;
  }
}
