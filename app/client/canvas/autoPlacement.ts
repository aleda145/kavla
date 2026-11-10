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
import type { LayoutDirection } from "./layoutQueryBranches";

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
const vector = { RIGHT: { x: 1, y: 0 }, LEFT: { x: -1, y: 0 }, DOWN: { x: 0, y: 1 }, UP: { x: 0, y: -1 } };
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
    const anchorShape = anchorId && editor.getShape(anchorId);
    let preferred = anchorId ? establishedDirection(anchorId) : "RIGHT";
    const siblings: Bounds[] = [];
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
        siblings.push(sibling);
        const direction = directionBetween(anchor, sibling);
        counts.set(direction, (counts.get(direction) ?? 0) + 1);
      }
      // A new sibling should use the existing fan-out, even if the parent was
      // reached from another direction earlier in the analysis.
      for (const direction of directions) {
        if ((counts.get(direction) ?? 0) > (counts.get(preferred) ?? 0)) preferred = direction;
      }
    }
    const sideBranch = shape.type === "sql-text-area" && anchorShape?.type === "data-source";
    let candidates = sideBranch ? directions : [preferred];
    if (views.has(shape.type)) {
      const table = shape.type === "sql-result-table";
      const tableSide: Record<LayoutDirection, LayoutDirection> = {
        RIGHT: "DOWN",
        DOWN: "RIGHT",
        LEFT: "UP",
        UP: "LEFT",
      };
      const side = tableSide[preferred];
      candidates = [table ? side : directions[(directions.indexOf(side) + 2) % 4]];
    } else if (shape.type === "knob") candidates = ["UP"];
    let best: { x: number; y: number; score: number; direction: LayoutDirection } | undefined;
    const obstacles = [...occupied].filter(
      ([id]) => id !== shape.id && !editor.hasAncestor(shape, id) && !editor.hasAncestor(id, shape.id)
    );
    const overlaps = (candidate: Bounds) =>
      obstacles.some(
        ([, other]) =>
          candidate.x < other.x + other.w + 28 &&
          candidate.x + candidate.w + 28 > other.x &&
          candidate.y < other.y + other.h + 28 &&
          candidate.y + candidate.h + 28 > other.y
      );
    refreshPaths();
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
    for (const direction of candidates) {
      const axis = vector[direction];
      const vertical = axis.y !== 0;
      const gap = views.has(shape.type) ? 48 : 120;
      const anchors =
        shape.type === "sql-text-area"
          ? inputs.map((id) => occupied.get(id)).filter((box): box is Bounds => !!box)
          : anchor
            ? [anchor]
            : [];
      let x = box.x,
        y = box.y;
      if (anchor && anchors.length) {
        x = anchor.x + (anchor.w - box.w) / 2;
        y = anchor.y + (anchor.h - box.h) / 2;
        if (direction === "RIGHT") x = Math.max(...anchors.map((b) => b.x + b.w)) + gap;
        if (direction === "LEFT") x = Math.min(...anchors.map((b) => b.x)) - box.w - gap;
        if (direction === "DOWN") y = Math.max(...anchors.map((b) => b.y + b.h)) + gap;
        if (direction === "UP") y = Math.min(...anchors.map((b) => b.y)) - box.h - gap;
      }
      // A bounded local search, with a clear outer lane as a crowded-board fallback.
      const offsets = [0, -1, 1, -2, 2, -3, 3].map((n) => n * ((vertical ? box.w : box.h) + 64));
      const outerOffsets: number[] = [];
      for (const sibling of siblings) {
        offsets.push(vertical ? sibling.x - box.w - 64 - x : sibling.y - box.h - 64 - y);
        offsets.push(vertical ? sibling.x + sibling.w + 64 - x : sibling.y + sibling.h + 64 - y);
      }
      if (obstacles.length) {
        outerOffsets.push(
          Math.min(...obstacles.map(([, b]) => (vertical ? b.x : b.y))) - (vertical ? box.w + x : box.h + y) - 64
        );
        outerOffsets.push(
          Math.max(...obstacles.map(([, b]) => (vertical ? b.x + b.w : b.y + b.h))) - (vertical ? x : y) + 64
        );
      }
      const nearby = [...new Set(offsets)].sort((a, b) => Math.abs(a) - Math.abs(b)).slice(0, 24);
      for (const offset of [...new Set([...nearby, ...outerOffsets])]) {
        const candidate = { x: x + (vertical ? offset : 0), y: y + (vertical ? 0 : offset), w: box.w, h: box.h };
        if (overlaps(candidate)) continue;
        const distance = Math.abs(offset) + (direction === preferred ? 0 : 80);
        if (best && distance >= best.score) continue;
        const crossings =
          [...paths.values()].filter((route) => crosses(route, shape.id, candidate)).length + connectorHits(candidate);
        const score = distance + crossings * 10000;
        if (!best || score < best.score) best = { ...candidate, score, direction };
      }
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
