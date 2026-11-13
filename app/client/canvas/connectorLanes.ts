import {
  getArrowBindings,
  getArrowInfo,
  type Editor,
  type TLArrowBinding,
  type TLArrowShape,
  type TLShapeId,
} from "tldraw";
import { crosses, readRoute, type Route } from "./arrowGeometry";
import { createLayoutBudget } from "./layoutBudget";

type Side = "left" | "right" | "top" | "bottom";
type Connector = { arrow: TLArrowShape; binding: TLArrowBinding; side: Side; cross: number };
const laneGap = 14;
const routingEditors = new WeakSet<Editor>();

export function isRoutingConnectorLanes(editor: Editor): boolean {
  return routingEditors.has(editor);
}

// Snapshot only routing fields. Restore them on an interrupted pass without
// undoing node moves or other changes made by the caller.
export function captureConnectorLanes(editor: Editor, nodeIds?: Set<TLShapeId>): () => void {
  const snapshots = editor.getCurrentPageShapes().flatMap((shape) => {
    if (shape.type !== "arrow" || shape.meta.kavlaConnector !== true || editor.isShapeOrAncestorLocked(shape))
      return [];
    const arrow = shape as TLArrowShape;
    const { start, end } = getArrowBindings(editor, arrow);
    const bindings = [start, end].filter((binding): binding is TLArrowBinding => !!binding);
    if (nodeIds && !bindings.some((binding) => nodeIds.has(binding.toId))) return [];
    return [{ arrow, bindings }];
  });
  return () => {
    for (const { arrow, bindings } of snapshots) {
      const currentArrow = editor.getShape<TLArrowShape>(arrow.id);
      if (!currentArrow) continue;
      for (const binding of bindings) {
        const current = editor.getBinding(binding.id) as TLArrowBinding | undefined;
        if (!current) continue;
        if (
          current.props.normalizedAnchor.x === binding.props.normalizedAnchor.x &&
          current.props.normalizedAnchor.y === binding.props.normalizedAnchor.y &&
          current.props.isPrecise === binding.props.isPrecise &&
          current.props.isExact === binding.props.isExact &&
          current.props.snap === binding.props.snap &&
          (current.meta.kavlaLane ?? null) === (binding.meta.kavlaLane ?? null) &&
          (current.meta.kavlaLaneAnchor ?? null) === (binding.meta.kavlaLaneAnchor ?? null)
        )
          continue;
        editor.updateBinding<TLArrowBinding>({
          id: binding.id,
          type: "arrow",
          props: {
            normalizedAnchor: binding.props.normalizedAnchor,
            isPrecise: binding.props.isPrecise,
            isExact: binding.props.isExact,
            snap: binding.props.snap,
          },
          meta: {
            kavlaLane: binding.meta.kavlaLane ?? null,
            kavlaLaneAnchor: binding.meta.kavlaLaneAnchor ?? null,
          },
        });
      }
      if (
        currentArrow.props.elbowMidPoint === arrow.props.elbowMidPoint &&
        (currentArrow.meta.kavlaLaneMidpoint ?? null) === (arrow.meta.kavlaLaneMidpoint ?? null) &&
        (currentArrow.meta.kavlaLaneAssignedMidpoint ?? null) === (arrow.meta.kavlaLaneAssignedMidpoint ?? null)
      )
        continue;
      editor.updateShape<TLArrowShape>({
        id: arrow.id,
        type: "arrow",
        props: { elbowMidPoint: arrow.props.elbowMidPoint },
        meta: {
          kavlaLaneMidpoint: arrow.meta.kavlaLaneMidpoint ?? null,
          kavlaLaneAssignedMidpoint: arrow.meta.kavlaLaneAssignedMidpoint ?? null,
        },
      });
    }
  };
}

// Stored as optional metadata on ordinary tldraw arrows/bindings, so documents
// remain readable without this routing pass. Only automatically assigned ports
// are restored; user-drawn arrows and manually anchored connectors are untouched.
export function resetConnectorLanes(editor: Editor, nodeIds?: Set<TLShapeId>): void {
  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type !== "arrow" || shape.meta.kavlaConnector !== true || editor.isShapeOrAncestorLocked(shape)) continue;
    const arrow = shape as TLArrowShape;
    const { start, end } = getArrowBindings(editor, arrow);
    if (nodeIds && ![start, end].some((binding) => binding && nodeIds.has(binding.toId))) continue;
    resetConnectorLane(editor, arrow);
  }
}

export function resetConnectorLane(editor: Editor, arrow: TLArrowShape): void {
  if (arrow.meta.kavlaConnector !== true || editor.isShapeOrAncestorLocked(arrow)) return;
  const { start, end } = getArrowBindings(editor, arrow);
  for (const binding of [start, end]) {
    if (binding?.meta.kavlaLane !== true) continue;
    editor.updateBinding<TLArrowBinding>({
      id: binding.id,
      type: "arrow",
      meta: { kavlaLane: false, kavlaLaneAnchor: null },
      props: { normalizedAnchor: { x: 0.5, y: 0.5 }, isPrecise: false, isExact: false, snap: "none" },
    });
  }
  if (typeof arrow.meta.kavlaLaneMidpoint === "number") {
    editor.updateShape<TLArrowShape>({
      id: arrow.id,
      type: "arrow",
      meta: { kavlaLaneMidpoint: null, kavlaLaneAssignedMidpoint: null },
      props: { elbowMidPoint: arrow.meta.kavlaLaneMidpoint },
    });
  }
}

// Measure overlapping parallel stretches and perpendicular crossings involving
// this bundle. Shared endpoints don't count as crossings.
function congestion(routes: Route[], ids: Set<TLShapeId>, canContinue: () => boolean) {
  let overlap = 0;
  let crossings = 0;
  for (let i = 0; i < routes.length; i++) {
    if (!ids.has(routes[i].id)) continue;
    for (let j = 0; j < routes.length; j++) {
      if (i === j || (ids.has(routes[j].id) && j < i)) continue;
      for (let a = 1; a < routes[i].points.length; a++) {
        const p = routes[i].points[a - 1],
          q = routes[i].points[a];
        for (let b = 1; b < routes[j].points.length; b++) {
          if (!canContinue()) return;
          const r = routes[j].points[b - 1],
            s = routes[j].points[b];
          const horizontal = Math.abs(p.y - q.y) < 0.01;
          const otherHorizontal = Math.abs(r.y - s.y) < 0.01;
          const vertical = Math.abs(p.x - q.x) < 0.01;
          const otherVertical = Math.abs(r.x - s.x) < 0.01;
          if (horizontal && otherHorizontal && Math.abs(p.y - r.y) < 6) {
            overlap += Math.max(
              0,
              Math.min(Math.max(p.x, q.x), Math.max(r.x, s.x)) - Math.max(Math.min(p.x, q.x), Math.min(r.x, s.x))
            );
          } else if (vertical && otherVertical && Math.abs(p.x - r.x) < 6) {
            overlap += Math.max(
              0,
              Math.min(Math.max(p.y, q.y), Math.max(r.y, s.y)) - Math.max(Math.min(p.y, q.y), Math.min(r.y, s.y))
            );
          } else if ((horizontal && otherVertical) || (vertical && otherHorizontal)) {
            const h1 = horizontal ? p : r,
              h2 = horizontal ? q : s;
            const v1 = vertical ? p : r,
              v2 = vertical ? q : s;
            if (
              v1.x > Math.min(h1.x, h2.x) + 1 &&
              v1.x < Math.max(h1.x, h2.x) - 1 &&
              h1.y > Math.min(v1.y, v2.y) + 1 &&
              h1.y < Math.max(v1.y, v2.y) - 1
            )
              crossings++;
          }
        }
      }
    }
  }
  return { overlap, crossings };
}

// A visible crossing is preferable to arrows disappearing into one shared line.
// Once overlap is equal, prefer fewer crossings. Node collisions are checked
// separately and are never introduced to improve this score.
function betterRouting(
  candidate: NonNullable<ReturnType<typeof congestion>>,
  current: NonNullable<ReturnType<typeof congestion>>
): boolean {
  if (candidate.overlap < current.overlap - 0.01) return true;
  return Math.abs(candidate.overlap - current.overlap) < 0.01 && candidate.crossings < current.crossings;
}

export function routeConnectorLanes(editor: Editor, nodeIds?: Set<TLShapeId>): void {
  if (editor.getIsReadonly() || routingEditors.has(editor)) return;
  routingEditors.add(editor);
  try {
    editor.run(() => {
      const restore = captureConnectorLanes(editor, nodeIds);
      const canContinue = createLayoutBudget(50, 200_000);
      let complete = false;
      try {
        routeLanes(editor, nodeIds, canContinue);
        complete = canContinue();
      } finally {
        // Arrival and departure bundles can share arrows. Roll back the whole
        // routing pass on exhaustion, so partial bundles never mix with old ones.
        if (!complete) restore();
      }
    });
  } finally {
    routingEditors.delete(editor);
  }
}

function routeLanes(editor: Editor, nodeIds: Set<TLShapeId> | undefined, canContinue: () => boolean): void {
  // Callers supply both endpoints of changed connectors. Handle their arrival
  // and departure bundles without walking the entire connected component.
  resetConnectorLanes(editor, nodeIds);
  const shapes = editor.getCurrentPageShapes();
  const arrowIds = shapes.filter((shape) => shape.type === "arrow").map((shape) => shape.id);
  const affectedIds = new Set(
    arrowIds.filter((id) => {
      const arrow = editor.getShape<TLArrowShape>(id)!;
      const { start, end } = getArrowBindings(editor, arrow);
      return (
        arrow.meta.kavlaConnector === true &&
        (!nodeIds || [start, end].some((binding) => binding && nodeIds.has(binding.toId)))
      );
    })
  );
  const cachedRoutes = new Map<TLShapeId, Route>();
  for (const id of arrowIds) {
    if (!canContinue()) return;
    const route = readRoute(editor, id);
    if (route) cachedRoutes.set(id, route);
  }
  const routes = (changedIds = affectedIds) => {
    for (const id of changedIds) {
      const route = readRoute(editor, id);
      if (route) cachedRoutes.set(id, route);
      else cachedRoutes.delete(id);
    }
    return [...cachedRoutes.values()];
  };
  const groups = new Map<string, Connector[]>();
  for (const shape of shapes) {
    if (!canContinue()) return;
    if (shape.type !== "arrow" || shape.meta.kavlaConnector !== true || editor.isShapeOrAncestorLocked(shape)) continue;
    if (!affectedIds.has(shape.id)) continue;
    const arrow = shape as TLArrowShape;
    const { start, end } = getArrowBindings(editor, arrow);
    if (arrow.props.kind !== "elbow" || !start || !end || start.toId === end.toId) continue;
    if (Math.abs(editor.getShapePageTransform(arrow).rotation()) > 0.00001) continue;
    const route = readRoute(editor, arrow.id);
    if (!route || route.points.length < 2) continue;
    for (const binding of [start, end]) {
      if (nodeIds && !nodeIds.has(binding.toId)) continue;
      if (binding.props.isPrecise || binding.props.isExact || binding.props.snap !== "none") continue;
      // Rotated nodes retain tldraw's normal routing on their actual edges.
      if (Math.abs(editor.getShapePageTransform(binding.toId).rotation()) > 0.00001) continue;
      const outgoing = binding.props.terminal === "start";
      const endpoint = outgoing ? route.points[0] : route.points[route.points.length - 1];
      const neighbor = outgoing ? route.points[1] : route.points[route.points.length - 2];
      const side: Side =
        Math.abs(endpoint.x - neighbor.x) >= Math.abs(endpoint.y - neighbor.y)
          ? neighbor.x < endpoint.x
            ? "left"
            : "right"
          : neighbor.y < endpoint.y
            ? "top"
            : "bottom";
      const horizontal = side === "left" || side === "right";
      const other = editor.getShapePageBounds(outgoing ? end.toId : start.toId);
      if (!other) continue;
      // Incoming and outgoing arrows sharing a side also get distinct ports.
      const key = `${binding.toId}:${side}`;
      const group = groups.get(key) ?? [];
      group.push({ arrow, binding, side, cross: horizontal ? other.center.y : other.center.x });
      groups.set(key, group);
    }
  }

  const obstacles = shapes.flatMap((shape) => {
    if (["arrow", "group", "frame", "agent-chat"].includes(shape.type)) return [];
    const box = editor.getShapePageBounds(shape);
    return box ? [{ id: shape.id, box }] : [];
  });
  for (const initialGroup of groups.values()) {
    if (!canContinue()) return;
    // Earlier bundles may have adjusted the opposite end or the same bend.
    // Snapshot the current records rather than restoring stale arrow props.
    const group = initialGroup.map((connector) => ({
      ...connector,
      arrow: editor.getShape<TLArrowShape>(connector.arrow.id)!,
      binding: editor.getBinding(connector.binding.id) as TLArrowBinding,
    }));
    if (group.length < 2) continue;
    group.sort((a, b) => a.cross - b.cross || a.arrow.id.localeCompare(b.arrow.id));
    const { side, binding } = group[0];
    const horizontal = side === "left" || side === "right";
    const axis = horizontal ? "x" : "y";
    const target = editor.getShapePageBounds(binding.toId)!;
    const crossSize = horizontal ? target.h : target.w;
    const spacing = Math.min(laneGap, (crossSize - 48) / (group.length - 1));
    if (spacing < 6) continue;
    const ids = new Set(group.map(({ arrow }) => arrow.id));
    const nodeHits = (paths: Route[]) =>
      new Set(
        paths
          .filter((route) => ids.has(route.id))
          .flatMap((route) =>
            obstacles.filter(({ id, box }) => crosses(route, id, box)).map(({ id }) => `${route.id}:${id}`)
          )
      );
    const baselineRoutes = routes();
    const baselineHits = nodeHits(baselineRoutes);
    const baseline = congestion(baselineRoutes, ids, canContinue);
    if (!baseline) return;
    let bestScore = baseline;
    let best: { arrow: TLArrowShape; binding: TLArrowBinding }[] | undefined;
    const consider = () => {
      if (!canContinue()) return;
      const currentRoutes = routes(ids);
      if ([...nodeHits(currentRoutes)].some((hit) => !baselineHits.has(hit))) return;
      const score = congestion(currentRoutes, ids, canContinue);
      if (!score || !betterRouting(score, bestScore)) return;
      bestScore = score;
      best = group.map(({ arrow, binding }) => ({
        arrow: editor.getShape<TLArrowShape>(arrow.id)!,
        binding: editor.getBinding(binding.id) as TLArrowBinding,
      }));
    };
    // Try both port orders: incoming and outgoing edges sharing a side may
    // need the opposite ordering to avoid crossing within the bundle.
    for (const order of [group, [...group].reverse()]) {
      if (!canContinue()) break;
      editor.updateBindings(
        order.map(({ binding }, i) => {
          const cross = 0.5 + ((i - (order.length - 1) / 2) * spacing) / crossSize;
          return {
            id: binding.id,
            type: "arrow",
            props: {
              isPrecise: true,
              isExact: false,
              snap: "none",
              normalizedAnchor: horizontal
                ? { x: side === "left" ? 0 : 1, y: cross }
                : { x: cross, y: side === "top" ? 0 : 1 },
            },
          };
        })
      );
      // Align the bends in the common free gap, with separate bend columns/rows.
      // The outermost opposite node turns nearest this shared node, avoiding
      // crossings for both fan-in and fan-out.
      const towardTarget = side === "left" || side === "top" ? 1 : -1;
      const ranges = order.map(({ arrow, cross }, i) => {
        const info = getArrowInfo(editor, arrow.id);
        if (info?.type !== "elbow" || info.route.midpointHandle?.axis !== axis) return;
        const range = horizontal ? info.elbow.midXRange : info.elbow.midYRange;
        if (!range || Math.abs(range.hi - range.lo) < 1) return;
        const transform = editor.getShapePageTransform(arrow.id);
        const origin = transform.applyToPoint({ x: 0, y: 0 })[axis];
        const portCross = (horizontal ? target.center.y : target.center.x) + (i - (order.length - 1) / 2) * spacing;
        const depth = cross <= portCross ? i : order.length - 1 - i;
        const offset = towardTarget * ((order.length - 1) / 2 - depth) * laneGap;
        return { lo: range.lo + origin, hi: range.hi + origin, offset };
      });
      if (ranges.every((range) => range !== undefined)) {
        const low = Math.max(...ranges.map((range) => Math.min(range.lo, range.hi) - range.offset));
        const high = Math.min(...ranges.map((range) => Math.max(range.lo, range.hi) - range.offset));
        if (high >= low) {
          for (const fraction of [0.5, 0.25, 0.75]) {
            if (!canContinue()) break;
            const corridor = low + (high - low) * fraction;
            editor.updateShapes<TLArrowShape>(
              order.map(({ arrow }, i) => ({
                id: arrow.id,
                type: "arrow",
                props: { elbowMidPoint: (corridor + ranges[i].offset - ranges[i].lo) / (ranges[i].hi - ranges[i].lo) },
              }))
            );
            consider();
          }
        }
      }
      // Port spacing alone can still help when there is no common bend corridor.
      editor.updateShapes<TLArrowShape>(
        order.map(({ arrow }) => ({ id: arrow.id, type: "arrow", props: { elbowMidPoint: arrow.props.elbowMidPoint } }))
      );
      consider();
    }
    if (best) {
      editor.updateBindings(
        best.map(({ binding }) => ({
          id: binding.id,
          type: "arrow",
          props: binding.props,
          meta: {
            ...binding.meta,
            kavlaLane: true,
            kavlaLaneAnchor: `${binding.props.normalizedAnchor.x},${binding.props.normalizedAnchor.y}`,
          },
        }))
      );
      editor.updateShapes<TLArrowShape>(
        best.map(({ arrow }, i) => ({
          id: arrow.id,
          type: "arrow",
          props: { elbowMidPoint: arrow.props.elbowMidPoint },
          meta: {
            ...arrow.meta,
            kavlaLaneMidpoint:
              typeof group[i].arrow.meta.kavlaLaneMidpoint === "number"
                ? group[i].arrow.meta.kavlaLaneMidpoint
                : group[i].arrow.props.elbowMidPoint,
            kavlaLaneAssignedMidpoint: arrow.props.elbowMidPoint,
          },
        }))
      );
    } else {
      editor.updateBindings(group.map(({ binding }) => ({ id: binding.id, type: "arrow", props: binding.props })));
      editor.updateShapes<TLArrowShape>(
        group.map(({ arrow }) => ({ id: arrow.id, type: "arrow", props: { elbowMidPoint: arrow.props.elbowMidPoint } }))
      );
    }
  }

  // Resolve remaining overlaps, including L-shaped/straight routes whose
  // terminal segment cannot be shifted by an elbow midpoint at all.
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const id of affectedIds) {
      if (!canContinue()) return;
      const arrow = editor.getShape<TLArrowShape>(id)!;
      if (arrow.meta.kavlaConnector !== true || arrow.props.kind !== "elbow" || editor.isShapeOrAncestorLocked(arrow))
        continue;
      const { start, end } = getArrowBindings(editor, arrow);
      if (!start || !end || (nodeIds && !nodeIds.has(start.toId) && !nodeIds.has(end.toId))) continue;
      if (
        [start, end].some(
          (binding) =>
            binding.props.isExact ||
            binding.props.snap !== "none" ||
            (binding.props.isPrecise && binding.meta.kavlaLane !== true)
        )
      )
        continue;
      if (Math.abs(editor.getShapePageTransform(arrow).rotation()) > 0.00001) continue;
      const info = getArrowInfo(editor, arrow);
      if (info?.type !== "elbow") continue;
      const paths = routes();
      const ids = new Set([id]);
      const baseline = congestion(paths, ids, canContinue);
      if (!baseline) return;
      if (baseline.overlap < 0.01) continue;
      const originalRoute = paths.find((route) => route.id === id);
      if (!originalRoute || originalRoute.points.length < 2) continue;
      const hits = new Set(obstacles.filter(({ id, box }) => crosses(originalRoute, id, box)).map(({ id }) => id));
      let bestScore = baseline;
      let best: { midpoint: number; bindings: TLArrowBinding[] } | undefined;
      const restore = () => {
        editor.updateBindings([start, end].map((binding) => ({ id: binding.id, type: "arrow", props: binding.props })));
        editor.updateShape<TLArrowShape>({ id, type: "arrow", props: { elbowMidPoint: arrow.props.elbowMidPoint } });
      };
      const consider = () => {
        if (!canContinue()) return;
        const nextPaths = routes(ids);
        const nextRoute = nextPaths.find((route) => route.id === id);
        if (!nextRoute || obstacles.some(({ id, box }) => !hits.has(id) && crosses(nextRoute, id, box))) return;
        const score = congestion(nextPaths, ids, canContinue);
        if (!score || !betterRouting(score, bestScore)) return;
        bestScore = score;
        best = {
          midpoint: editor.getShape<TLArrowShape>(id)!.props.elbowMidPoint,
          bindings: [start, end].map((binding) => editor.getBinding(binding.id) as TLArrowBinding),
        };
      };
      const axis = info.route.midpointHandle?.axis;
      const range = axis === "x" ? info.elbow.midXRange : axis === "y" ? info.elbow.midYRange : null;
      if (axis && range && Math.abs(range.hi - range.lo) >= 1) {
        const origin = editor.getShapePageTransform(arrow).applyToPoint({ x: 0, y: 0 })[axis];
        const current = info.route.midpointHandle!.point[axis] + origin;
        const candidates = new Set([
          current - laneGap,
          current + laneGap,
          current - 2 * laneGap,
          current + 2 * laneGap,
        ]);
        for (const route of paths) {
          if (route.id === id) continue;
          for (let i = 1; i < route.points.length; i++) {
            if (Math.abs(route.points[i][axis] - route.points[i - 1][axis]) > 0.01) continue;
            candidates.add(route.points[i][axis] - laneGap);
            candidates.add(route.points[i][axis] + laneGap);
          }
        }
        const positions = [...candidates]
          .filter(
            (value) => value >= origin + Math.min(range.lo, range.hi) && value <= origin + Math.max(range.lo, range.hi)
          )
          .sort((a, b) => Math.abs(a - current) - Math.abs(b - current))
          .slice(0, 64);
        for (const position of positions) {
          if (!canContinue()) break;
          const midpoint = (position - origin - range.lo) / (range.hi - range.lo);
          editor.updateShape<TLArrowShape>({ id, type: "arrow", props: { elbowMidPoint: midpoint } });
          consider();
          if (bestScore.overlap < 0.01 && bestScore.crossings === 0) break;
        }
        restore();
      }
      if (bestScore.overlap > 0.01 || bestScore.crossings > 0) {
        for (const binding of [start, end]) {
          if (!canContinue()) break;
          if (Math.abs(editor.getShapePageTransform(binding.toId).rotation()) > 0.00001) continue;
          const box = editor.getShapePageBounds(binding.toId);
          if (!box) continue;
          const outgoing = binding.props.terminal === "start";
          const endpoint = outgoing ? originalRoute.points[0] : originalRoute.points[originalRoute.points.length - 1];
          const neighbor = outgoing ? originalRoute.points[1] : originalRoute.points[originalRoute.points.length - 2];
          const horizontal = Math.abs(endpoint.x - neighbor.x) >= Math.abs(endpoint.y - neighbor.y);
          const crossAxis = horizontal ? "y" : "x";
          const crossSize = horizontal ? box.h : box.w;
          const crossOrigin = horizontal ? box.y : box.x;
          const current = endpoint[crossAxis];
          const candidates = new Set([-3, -2, -1, 1, 2, 3].map((step) => current + step * laneGap));
          for (const route of paths) {
            if (route.id === id) continue;
            for (let i = 1; i < route.points.length; i++) {
              if (Math.abs(route.points[i][crossAxis] - route.points[i - 1][crossAxis]) > 0.01) continue;
              candidates.add(route.points[i][crossAxis] - laneGap);
              candidates.add(route.points[i][crossAxis] + laneGap);
            }
          }
          const positions = [...candidates]
            .filter((value) => value >= crossOrigin + 24 && value <= crossOrigin + crossSize - 24)
            .sort((a, b) => Math.abs(a - current) - Math.abs(b - current))
            .slice(0, 24);
          for (const position of positions) {
            if (!canContinue()) break;
            const cross = (position - crossOrigin) / crossSize;
            editor.updateBinding<TLArrowBinding>({
              id: binding.id,
              type: "arrow",
              props: {
                isPrecise: true,
                isExact: false,
                snap: "none",
                normalizedAnchor: horizontal
                  ? { x: neighbor.x < endpoint.x ? 0 : 1, y: cross }
                  : { x: cross, y: neighbor.y < endpoint.y ? 0 : 1 },
              },
            });
            consider();
            if (bestScore.overlap < 0.01 && bestScore.crossings === 0) break;
          }
          restore();
          if (bestScore.overlap < 0.01 && bestScore.crossings === 0) break;
        }
      }
      if (best) {
        editor.updateBindings(
          best.bindings.map((binding, i) => ({
            id: binding.id,
            type: "arrow",
            props: binding.props,
            // Only claim a port if this pass actually changed it.
            meta:
              binding.props.isPrecise &&
              (binding.props.normalizedAnchor.x !== [start, end][i].props.normalizedAnchor.x ||
                binding.props.normalizedAnchor.y !== [start, end][i].props.normalizedAnchor.y ||
                ![start, end][i].props.isPrecise)
                ? {
                    kavlaLane: true,
                    kavlaLaneAnchor: `${binding.props.normalizedAnchor.x},${binding.props.normalizedAnchor.y}`,
                  }
                : binding.meta,
          }))
        );
        editor.updateShape<TLArrowShape>({
          id,
          type: "arrow",
          props: { elbowMidPoint: best.midpoint },
          meta: {
            kavlaLaneMidpoint:
              typeof arrow.meta.kavlaLaneMidpoint === "number"
                ? arrow.meta.kavlaLaneMidpoint
                : arrow.props.elbowMidPoint,
            kavlaLaneAssignedMidpoint: best.midpoint,
          },
        });
        changed = true;
      }
    }
    if (!changed) break;
  }
}
