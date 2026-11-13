import {
  atom,
  getArrowBindings,
  type Editor,
  type TLArrowBinding,
  type TLArrowShape,
  type TLShape,
  type TLShapeId,
} from "tldraw";
import { extractTableNames } from "../../util/parseSql";
import { crosses, readRoute, type Bounds, type Route } from "./arrowGeometry";
import { resetConnectorLane } from "./connectorLanes";
import type { LayoutDirection } from "./layoutQueryBranches";

export function getAutoPlacementRadius(
  parent: Pick<Bounds, "w" | "h">,
  child: Pick<Bounds, "w" | "h">,
  gap: number
): number {
  return Math.hypot((parent.w + child.w) / 2 + gap, (parent.h + child.h) / 2 + gap);
}

// Shared by insertion and the read-only debug preview. Arrow routing and flow
// preferences rank positions afterwards; only lack of space expands the circle.
export function getAutoPlacementSearch(
  center: Bounds,
  child: Pick<Bounds, "w" | "h">,
  obstacles: Bounds[],
  routes: Route[],
  gap: number
): { initialRadius: number; radius: number; candidates: Bounds[] } {
  const originX = center.x + (center.w - child.w) / 2;
  const originY = center.y + (center.h - child.h) / 2;
  const reachX = (center.w + child.w) / 2 + gap;
  const reachY = (center.h + child.h) / 2 + gap;
  const initialRadius = getAutoPlacementRadius(center, child, gap);
  let radius = initialRadius;
  // Search a circle around the parent on all sides. Expand only when there
  // is no shape-sized empty space inside it, never to satisfy flow preference.
  while (true) {
    const xs = new Set([originX, originX - reachX, originX + reachX]);
    const ys = new Set([originY, originY - reachY, originY + reachY]);
    const addEdges = (other: Bounds, clearances: number[]) => {
      if (
        other.x > originX + radius + child.w + 64 ||
        other.x + other.w < originX - radius - 64 ||
        other.y > originY + radius + child.h + 64 ||
        other.y + other.h < originY - radius - 64
      )
        return;
      // Obstacle edges find actual pockets, including gaps a fixed grid misses.
      for (const clearance of clearances) {
        xs.add(other.x - child.w - clearance);
        xs.add(other.x + other.w + clearance);
        ys.add(other.y - child.h - clearance);
        ys.add(other.y + other.h + clearance);
      }
    };
    for (const other of obstacles) addEdges(other, [28, 64]);
    for (const route of routes) {
      for (let i = 1; i < route.points.length; i++) {
        const a = route.points[i - 1],
          b = route.points[i];
        addEdges(
          { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) },
          [28]
        );
      }
    }
    const candidates: Bounds[] = [];
    for (const x of xs) {
      if (Math.abs(x - originX) > radius) continue;
      for (const y of ys) {
        if (Math.hypot(x - originX, y - originY) > radius) continue;
        if (
          obstacles.some(
            (other) =>
              x < other.x + other.w + 28 &&
              x + child.w + 28 > other.x &&
              y < other.y + other.h + 28 &&
              y + child.h + 28 > other.y
          )
        )
          continue;
        candidates.push({ x, y, w: child.w, h: child.h });
      }
    }
    if (candidates.length) return { initialRadius, radius, candidates };
    radius *= 1.5;
  }
}

const storageKey = "kavla.auto-placement";
export const autoPlacement = atom(
  "Auto placement",
  typeof localStorage !== "undefined" && localStorage.getItem(storageKey) === "true"
);
export function toggleAutoPlacement() {
  const enabled = !autoPlacement.get();
  localStorage.setItem(storageKey, String(enabled));
  autoPlacement.set(enabled);
}

const nodeTypes = new Set([
  "data-source",
  "sql-text-area",
  "sql-result-table",
  "chart-shape",
  "lens-shape",
  "knob",
  "summary-shape",
]);
const views = new Set(["sql-result-table", "chart-shape", "lens-shape"]);
const directions: LayoutDirection[] = ["RIGHT", "DOWN", "LEFT", "UP"];
function directionBetween(a: Bounds, b: Bounds): LayoutDirection {
  const dx = b.x + b.w / 2 - a.x - a.w / 2;
  const dy = b.y + b.h / 2 - a.y - a.h / 2;
  return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "RIGHT" : "LEFT") : dy >= 0 ? "DOWN" : "UP";
}

export function registerAutoPlacement(editor: Editor, canPlace: () => boolean): () => void {
  // Build occupancy once, then maintain it from changes. Placement never runs
  // ELK or walks the existing DAG; only the new batch is dependency-ordered.
  const occupied = new Map<TLShapeId, Bounds>();
  const paths = new Map<TLShapeId, Route>();
  const names = new Map<string, TLShapeId>();
  const seen = new Set(editor.getCurrentPageShapes().map((shape) => shape.id));
  const pending = new Set<TLShapeId>();
  const dirty = new Set<TLShapeId>();
  const dirtyArrows = new Set<TLShapeId>();
  const flow = new Map<TLShapeId, LayoutDirection>();
  let placing = false;
  const index = (shape: TLShape) => {
    if (editor.getAncestorPageId(shape) !== editor.getCurrentPageId()) return;
    if (shape.type === "arrow") dirtyArrows.add(shape.id);
    else if (!["group", "frame", "agent-chat", "agent-blob"].includes(shape.type)) {
      const box = editor.getShapePageBounds(shape);
      if (box) occupied.set(shape.id, { x: box.x, y: box.y, w: box.w, h: box.h });
    }
    if (shape.type === "sql-text-area" || shape.type === "data-source") {
      names.set(String((shape.props as { name: string }).name).toLowerCase(), shape.id);
    }
    for (const binding of editor.getBindingsToShape(shape.id, "arrow")) dirtyArrows.add(binding.fromId);
  };
  editor.getCurrentPageShapes().forEach(index);
  const refreshPaths = () => {
    for (const id of dirtyArrows) {
      const route = readRoute(editor, id);
      if (route) paths.set(id, route);
      else paths.delete(id);
    }
    dirtyArrows.clear();
  };
  const parents = (shape: TLShape): TLShapeId[] => {
    const props = shape.props as {
      sourceShapeId?: string;
      upstreamShapeIds?: string[];
      downstreamShapeIds?: string[];
      text?: string;
      artifacts?: { shapeId: string }[];
    };
    const ids = new Set<string>(props.upstreamShapeIds ?? []);
    if (props.sourceShapeId) ids.add(props.sourceShapeId);
    if (props.artifacts) props.artifacts.forEach((artifact) => ids.add(artifact.shapeId));
    if (shape.type === "knob") props.downstreamShapeIds?.forEach((id) => ids.add(id));
    if (shape.type === "sql-text-area" && props.text) {
      for (const name of extractTableNames(props.text)) {
        const id = names.get(name.toLowerCase());
        if (id) ids.add(id);
      }
    }
    for (const binding of editor.getBindingsToShape<TLArrowBinding>(shape.id, "arrow")) {
      if (binding.props.terminal !== "end") continue;
      const arrow = editor.getShape<TLArrowShape>(binding.fromId);
      const start = arrow && getArrowBindings(editor, arrow).start;
      if (start) ids.add(start.toId);
    }
    return [...ids].filter((id) => id !== shape.id && editor.getShape(id as TLShapeId)).map((id) => id as TLShapeId);
  };
  const establishedDirection = (id: TLShapeId): LayoutDirection => {
    const node = editor.getShape(id);
    if (!node) return "RIGHT";
    // A moved node's current relationship wins over a previously inferred flow.
    const upstreamId = parents(node).find((parent) => editor.getShape(parent)?.type !== "knob");
    const upstream = upstreamId && occupied.get(upstreamId);
    const box = occupied.get(id);
    return upstream && box ? directionBetween(upstream, box) : (flow.get(id) ?? "RIGHT");
  };
  const insert = (shape: TLShape, inputs: TLShapeId[]) => {
    const box = occupied.get(shape.id);
    if (!box) return;
    const bindings = editor.getBindingsToShape<TLArrowBinding>(shape.id, "arrow");
    const connectorIds = new Set(bindings.map((binding) => binding.fromId));
    // Creation helpers add bindings just after creating the shape. Wait for
    // those so we can measure the real connector, rather than guessing its path.
    if (shape.type === "sql-text-area" || views.has(shape.type)) {
      const connectedInputs = new Set(
        bindings
          .filter((binding) => binding.props.terminal === "end")
          .flatMap((binding) => {
            const arrow = editor.getShape<TLArrowShape>(binding.fromId);
            const start = arrow && getArrowBindings(editor, arrow).start;
            return start ? [start.toId] : [];
          })
      );
      if (inputs.some((id) => editor.getShape(id)?.type !== "knob" && !connectedInputs.has(id))) return;
    }
    // A chart sourced through a result still belongs beside the original query.
    let anchorId = inputs.find((id) => editor.getShape(id)?.type !== "knob") ?? inputs[0];
    const visited = new Set<TLShapeId>();
    while (anchorId && views.has(editor.getShape(anchorId)!.type) && !visited.has(anchorId)) {
      visited.add(anchorId);
      const source = parents(editor.getShape(anchorId)!)[0];
      if (!source) break;
      anchorId = source;
    }
    const anchor = anchorId && occupied.get(anchorId);
    let preferred = anchorId ? establishedDirection(anchorId) : "RIGHT";
    if (shape.type === "sql-text-area" && anchorId && anchor) {
      const counts = new Map<LayoutDirection, number>();
      for (const binding of editor.getBindingsToShape<TLArrowBinding>(anchorId, "arrow")) {
        if (binding.props.terminal !== "start") continue;
        const arrow = editor.getShape<TLArrowShape>(binding.fromId);
        const end = arrow && getArrowBindings(editor, arrow).end;
        if (
          !end ||
          end.toId === shape.id ||
          pending.has(end.toId) ||
          editor.getShape(end.toId)?.type !== "sql-text-area"
        )
          continue;
        const sibling = occupied.get(end.toId);
        if (!sibling) continue;
        const direction = directionBetween(anchor, sibling);
        counts.set(direction, (counts.get(direction) ?? 0) + 1);
      }
      // A new sibling should use the existing fan-out, even if the parent was
      // reached from another direction earlier in the analysis.
      for (const direction of directions) {
        if ((counts.get(direction) ?? 0) > (counts.get(preferred) ?? 0)) preferred = direction;
      }
    }
    let preferredSide = preferred;
    if (views.has(shape.type)) {
      const table = shape.type === "sql-result-table";
      const tableSide: Record<LayoutDirection, LayoutDirection> = {
        RIGHT: "DOWN",
        DOWN: "RIGHT",
        LEFT: "UP",
        UP: "LEFT",
      };
      const side = tableSide[preferred];
      preferredSide = table ? side : directions[(directions.indexOf(side) + 2) % 4];
    } else if (shape.type === "knob") preferredSide = "UP";
    let best: { x: number; y: number; score: number; hits: number; direction: LayoutDirection } | undefined;
    const obstacles = [...occupied].filter(
      ([id]) => id !== shape.id && !editor.hasAncestor(shape, id) && !editor.hasAncestor(id, shape.id)
    );
    refreshPaths();
    // The lane pass resets automatic ports before routing. Probe that same
    // geometry, otherwise a clear pinned route can become obstructed afterwards.
    // Only touch connectors adjacent to this insertion, not the existing DAG.
    const adjacentArrows = new Set(connectorIds);
    for (const id of new Set([...inputs, ...(anchorId ? [anchorId] : [])])) {
      for (const binding of editor.getBindingsToShape<TLArrowBinding>(id, "arrow")) adjacentArrows.add(binding.fromId);
    }
    const previousPaths = [...adjacentArrows].flatMap((id) => {
      const route = paths.get(id);
      return route ? [route] : [];
    });
    for (const id of adjacentArrows) {
      const arrow = editor.getShape<TLArrowShape>(id);
      if (arrow) resetConnectorLane(editor, arrow);
      dirtyArrows.add(id);
    }
    refreshPaths();
    // Keep space for both the current lanes and the natural routes used as the
    // baseline when lanes are recomputed after the insertion.
    const existingPaths = [...previousPaths, ...paths.values()].filter(
      (route) => !connectorIds.has(route.id) && ![...route.ends].some((id) => pending.has(id))
    );
    const origin = editor.getShapePageTransform(shape).applyToPoint({ x: 0, y: 0 });
    const positionUpdate = (candidate: { x: number; y: number }) => {
      const point = editor.getPointInParentSpace(shape, {
        x: origin.x + candidate.x - box.x,
        y: origin.y + candidate.y - box.y,
      });
      return { id: shape.id, type: shape.type, x: point.x, y: point.y };
    };
    const fixedObstacles = obstacles.filter(([id]) => !pending.has(id));
    const connectorHits = (candidate: Bounds) => {
      if (!connectorIds.size) return 0;
      // Probe only this new node. tldraw's operation batches these changes, so
      // intermediate candidates aren't rendered or separate undo steps.
      editor.updateShape(positionUpdate(candidate));
      try {
        const hits = new Set<TLShapeId>();
        for (const id of connectorIds) {
          const route = readRoute(editor, id);
          if (!route || [...route.ends].some((end) => end !== shape.id && pending.has(end))) continue;
          for (const [id, obstacle] of fixedObstacles) {
            if (crosses(route, id, obstacle)) hits.add(id);
          }
        }
        return hits.size;
      } finally {
        editor.updateShape({ id: shape.id, type: shape.type, x: shape.x, y: shape.y });
      }
    };
    const center = anchor ?? box;
    const originX = center.x + (center.w - box.w) / 2;
    const originY = center.y + (center.h - box.h) / 2;
    const gap = views.has(shape.type) ? 48 : 120;
    const search = getAutoPlacementSearch(
      center,
      box,
      obstacles.map(([, bounds]) => bounds),
      existingPaths,
      gap
    );
    const candidates = search.candidates.map((candidate) => {
      const { x, y } = candidate;
      const distance = Math.hypot(x - originX, y - originY);
      const direction = directionBetween(center, candidate);
      const edgeGap = {
        RIGHT: x - center.x - center.w,
        LEFT: center.x - x - box.w,
        DOWN: y - center.y - center.h,
        UP: center.y - y - box.h,
      }[direction];
      // Keep a comfortable connector gap when possible. Both that gap and
      // flow direction are preferences, so tight local pockets remain usable.
      const score = distance + (direction === preferredSide ? 0 : 240) + (anchor ? Math.max(0, gap - edgeGap) * 2 : 0);
      const hits = new Set(
        existingPaths.filter((route) => crosses(route, shape.id, candidate)).map((route) => route.id)
      ).size;
      return { ...candidate, direction, score, hits };
    });
    candidates.sort((a, b) => a.hits - b.hits || a.score - b.score);
    let probes = 0;
    for (const candidate of candidates) {
      if (best && (candidate.hits > best.hits || (candidate.hits === best.hits && candidate.score >= best.score)))
        continue;
      const hits = candidate.hits + connectorHits(candidate);
      if (!best || hits < best.hits || (hits === best.hits && candidate.score < best.score))
        best = { ...candidate, hits };
      // Geometry checks are cheap. Bound actual tldraw route probes on very
      // crowded boards, and keep the best nearby placement found so far.
      if (++probes >= 96) break;
    }
    if (!best) return;
    // Remove before updating so the placement itself cannot become another insertion.
    pending.delete(shape.id);
    editor.updateShape(positionUpdate(best));
    flow.set(shape.id, views.has(shape.type) ? preferred : best.direction);
    index(editor.getShape(shape.id)!);
  };
  const disposers = [
    editor.sideEffects.registerAfterCreateHandler("shape", (shape, source) => {
      index(shape);
      const known = seen.has(shape.id);
      seen.add(shape.id);
      if (
        known ||
        source !== "user" ||
        !autoPlacement.get() ||
        !canPlace() ||
        editor.getAncestorPageId(shape) !== editor.getCurrentPageId() ||
        !nodeTypes.has(shape.type) ||
        shape.meta.autoPlacement === false
      )
        return;
      pending.add(shape.id);
      dirty.add(shape.id);
      // Forward references in a multi-operation batch may become available now.
      for (const id of pending) dirty.add(id);
    }),
    editor.sideEffects.registerAfterChangeHandler("shape", (before, after) => {
      if (before.type === "sql-text-area" || before.type === "data-source") {
        const name = String((before.props as { name: string }).name).toLowerCase();
        if (names.get(name) === before.id) names.delete(name);
      }
      const beforeSize = before.props as { w?: number; h?: number };
      const afterSize = after.props as { w?: number; h?: number };
      const geometryChanged =
        before.x !== after.x ||
        before.y !== after.y ||
        before.rotation !== after.rotation ||
        before.parentId !== after.parentId ||
        beforeSize.w !== afterSize.w ||
        beforeSize.h !== afterSize.h;
      // Native text/drawings can change bounds without explicit dimensions.
      if (geometryChanged || !nodeTypes.has(after.type)) index(after);
      else if (after.type === "sql-text-area" || after.type === "data-source") {
        names.set(String((after.props as { name: string }).name).toLowerCase(), after.id);
      }
      if (
        !placing &&
        pending.has(after.id) &&
        (before.x !== after.x || before.y !== after.y || before.parentId !== after.parentId)
      ) {
        pending.delete(after.id); // Respect a user's manual placement before linking.
      }
      if (pending.has(after.id)) dirty.add(after.id);
      if (geometryChanged && (after.type === "group" || after.type === "frame")) {
        for (const id of editor.getShapeAndDescendantIds([after.id])) {
          const child = editor.getShape(id);
          if (child) index(child);
        }
      }
    }),
    editor.sideEffects.registerAfterCreateHandler("binding", (binding) => {
      if (binding.type !== "arrow") return;
      dirtyArrows.add(binding.fromId);
      if (pending.has(binding.toId)) {
        for (const id of pending) dirty.add(id);
      }
    }),
    editor.sideEffects.registerAfterChangeHandler("binding", (before, after) => {
      if (before.type === "arrow") dirtyArrows.add(before.fromId);
      if (after.type === "arrow") dirtyArrows.add(after.fromId);
    }),
    editor.sideEffects.registerAfterDeleteHandler("binding", (binding) => {
      if (binding.type === "arrow") dirtyArrows.add(binding.fromId);
    }),
    editor.sideEffects.registerAfterDeleteHandler("shape", (shape) => {
      occupied.delete(shape.id);
      paths.delete(shape.id);
      pending.delete(shape.id);
      flow.delete(shape.id);
      if ("name" in shape.props && names.get(String(shape.props.name).toLowerCase()) === shape.id)
        names.delete(String(shape.props.name).toLowerCase());
    }),
    editor.sideEffects.registerOperationCompleteHandler(() => {
      if (placing || !dirty.size) return;
      if (!autoPlacement.get() || !canPlace() || editor.getIsReadonly()) {
        pending.clear();
        dirty.clear();
        return;
      }
      const batch = new Set(dirty);
      dirty.clear();
      const visiting = new Set<TLShapeId>();
      const done = new Set<TLShapeId>();
      const visit = (id: TLShapeId) => {
        if (done.has(id) || visiting.has(id) || !pending.has(id)) return;
        const shape = editor.getShape(id);
        if (!shape || editor.isShapeOrAncestorLocked(shape)) {
          pending.delete(id);
          return;
        }
        visiting.add(id);
        const inputs = parents(shape);
        inputs.filter((input) => pending.has(input)).forEach(visit);
        visiting.delete(id);
        done.add(id);
        if (inputs.some((input) => pending.has(input))) return;
        if (inputs.length || shape.type === "data-source" || shape.type === "summary-shape") insert(shape, inputs);
      };
      placing = true;
      try {
        batch.forEach(visit);
      } finally {
        placing = false;
      }
    }),
  ];
  return () => disposers.forEach((dispose) => dispose());
}
