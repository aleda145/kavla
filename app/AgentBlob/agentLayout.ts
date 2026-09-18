import type { Editor, TLArrowBinding, TLShapeId } from "tldraw";
import type { SQLTextAreaShape } from "../SQLTextArea/sql-text-area-types";

export type AgentPlacement = "right" | "left" | "below" | "above" | "summary";

export type AgentLayout = {
  parentShapeId: TLShapeId | null;
  order: number;
  placement: AgentPlacement;
  x?: number;
  y?: number;
};

type LayoutRect = { minX: number; minY: number; maxX: number; maxY: number };

function layoutObject(args: Record<string, unknown>) {
  return args.layout && typeof args.layout === "object" ? args.layout as Record<string, unknown> : {};
}

export function getAgentLayout(
  args: Record<string, unknown>,
  fallbackParentShapeId: TLShapeId | null,
  defaultPlacement: AgentPlacement,
): AgentLayout {
  const layout = layoutObject(args);
  const placement = typeof layout.placement === "string" ? layout.placement : defaultPlacement;
  if ((layout.x !== undefined || layout.y !== undefined) && (typeof layout.x !== "number" || !Number.isFinite(layout.x) || typeof layout.y !== "number" || !Number.isFinite(layout.y))) throw new Error("Supply both finite page coordinates layout.x and layout.y.");
  const rawOrder = typeof layout.order === "number" && Number.isFinite(layout.order) ? layout.order : 0;
  return {
    ...(typeof layout.x === "number" && typeof layout.y === "number" ? { x: layout.x, y: layout.y } : {}),
    parentShapeId: typeof layout.parentShapeId === "string"
      ? layout.parentShapeId as TLShapeId
      : fallbackParentShapeId,
    order: Math.max(0, Math.min(20, rawOrder)),
    placement: ["right", "left", "below", "above", "summary"].includes(placement)
      ? placement as AgentPlacement
      : defaultPlacement,
  };
}

function overlaps(a: LayoutRect, b: LayoutRect) {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

export function getAgentShapeBounds(editor: Editor, id: TLShapeId) {
  const bounds = editor.getShapePageBounds(id);
  return bounds ? { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h } : null;
}

export function getAgentCanvasLayout(editor: Editor) {
  return editor.getCurrentPageShapes()
    .filter((shape) => !["agent-chat", "agent-blob"].includes(shape.type))
    .slice(0, 200)
    .map((shape) => ({
      id: shape.id,
      type: shape.type,
      name: "name" in shape.props ? shape.props.name : undefined,
      bounds: getAgentShapeBounds(editor, shape.id),
      isLocked: shape.isLocked,
      ...(shape.type === "arrow" ? {
        points: editor.getShapeGeometry(shape).getVertices({ includeLabels: false, includeInternal: false }).map((point) => {
          const page = editor.getShapePageTransform(shape).applyToPoint(point);
          return { x: page.x, y: page.y };
        }),
      } : {}),
    }));
}

type ArrowSegment = {
  arrowId: TLShapeId;
  targets: TLShapeId[];
  start: { x: number; y: number };
  end: { x: number; y: number };
};

function arrowSegments(editor: Editor): ArrowSegment[] {
  return editor.getCurrentPageShapes().filter((shape) => shape.type === "arrow").flatMap((arrow) => {
    const targets = editor.getBindingsFromShape<TLArrowBinding>(arrow, "arrow").map((binding) => binding.toId);
    const transform = editor.getShapePageTransform(arrow);
    const points = editor.getShapeGeometry(arrow).getVertices({ includeLabels: false, includeInternal: false }).map((point) => transform.applyToPoint(point));
    return points.slice(1).map((point, index) => ({ arrowId: arrow.id, targets, start: points[index], end: point }));
  });
}

// Clip the actual segment against a padded rectangle, including diagonal arrows.
function crosses(rect: LayoutRect, segment: ArrowSegment, padding = 18) {
  let enter = 0, leave = 1;
  for (const axis of ["x", "y"] as const) {
    const low = (axis === "x" ? rect.minX : rect.minY) - padding;
    const high = (axis === "x" ? rect.maxX : rect.maxY) + padding;
    const start = segment.start[axis], delta = segment.end[axis] - start;
    if (Math.abs(delta) < 1e-8) {
      if (start < low || start > high) return false;
      continue;
    }
    const a = (low - start) / delta, b = (high - start) / delta;
    enter = Math.max(enter, Math.min(a, b));
    leave = Math.min(leave, Math.max(a, b));
    if (enter > leave) return false;
  }
  return true;
}

function crossingCount(rect: LayoutRect, segments: ArrowSegment[]) {
  return new Set(segments.filter((segment) => crosses(rect, segment)).map((segment) => segment.arrowId)).size;
}

export function getAgentArrowOverlaps(editor: Editor, affectedIds: TLShapeId[]) {
  const affected = new Set(affectedIds);
  if (!affected.size) return [];
  const segments = arrowSegments(editor);
  const conflicts: Array<{ shapeId: TLShapeId; arrowIds: TLShapeId[] }> = [];
  for (const shape of editor.getCurrentPageShapes()) {
    if (["arrow", "agent-chat", "agent-blob"].includes(shape.type)) continue;
    const bounds = editor.getShapePageBounds(shape.id);
    if (!bounds) continue;
    const arrowIds = new Set(segments.filter((segment) =>
      (affected.has(shape.id) || segment.targets.some((id) => affected.has(id))) &&
      !segment.targets.includes(shape.id) &&
      !segment.targets.some((id) => editor.hasAncestor(id, shape.id)) &&
      crosses(bounds, segment)
    ).map((segment) => segment.arrowId));
    if (arrowIds.size) conflicts.push({ shapeId: shape.id, arrowIds: [...arrowIds] });
  }
  return conflicts;
}

export function getAgentPlacement(
  editor: Editor,
  layout: AgentLayout,
  fallbackAnchorShapeId: TLShapeId | null,
  size: { w: number; h: number },
  movingShapeId: TLShapeId | null = null,
) {
  const anchorShapeId = layout.parentShapeId && editor.getShape(layout.parentShapeId)
    ? layout.parentShapeId
    : fallbackAnchorShapeId;
  const anchorBounds = anchorShapeId ? editor.getShapePageBounds(anchorShapeId) : null;
  const viewportCenter = editor.getViewportPageBounds().center;
  const anchor = anchorBounds ?? {
    minX: viewportCenter.x,
    minY: viewportCenter.y,
    maxX: viewportCenter.x,
    maxY: viewportCenter.y,
    width: 0,
    height: 0,
  };
  const occupied = editor.getCurrentPageShapes()
    .filter((shape) => shape.id !== movingShapeId && shape.type !== "arrow" && shape.type !== "agent-chat" && shape.type !== "agent-blob")
    .flatMap((shape) => {
      const bounds = editor.getShapePageBounds(shape.id);
      return bounds ? [{
        minX: bounds.minX - 28,
        minY: bounds.minY - 28,
        maxX: bounds.maxX + 28,
        maxY: bounds.maxY + 28,
      }] : [];
    });
  const segments = arrowSegments(editor).filter((segment) => !movingShapeId || !segment.targets.includes(movingShapeId));
  if (layout.x !== undefined && layout.y !== undefined) {
    const rect = { minX: layout.x, minY: layout.y, maxX: layout.x + size.w, maxY: layout.y + size.h };
    if (occupied.some((other) => overlaps(rect, other))) throw new Error("Requested placement overlaps another shape. Read canvasLayout and leave at least 30 units of clearance.");
    let best = { x: layout.x, y: layout.y, score: crossingCount(rect, segments) * 6000 };
    if (best.score === 0) return best;
    // Try only the immediate neighborhood; never move a new node far from its intended story.
    for (let dx = -160; dx <= 160; dx += 40) {
      for (let dy = -160; dy <= 160; dy += 40) {
        const candidate = { minX: rect.minX + dx, maxX: rect.maxX + dx, minY: rect.minY + dy, maxY: rect.maxY + dy };
        if (occupied.some((other) => overlaps(candidate, other))) continue;
        const score = crossingCount(candidate, segments) * 6000 + Math.abs(dx) + Math.abs(dy);
        if (score < best.score) best = { x: layout.x + dx, y: layout.y + dy, score };
      }
    }
    return best;
  }

  const xGap = 70;
  const yGap = 60;
  const xStep = size.w + xGap;
  const yStep = size.h + yGap;
  const sideOffsets = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5];
  const directions: AgentPlacement[] = ["right", "below", "left", "above", "summary"];
  const preferredDirections = [layout.placement, ...directions.filter((direction) => direction !== layout.placement)];
  const anchorCenter = { x: anchor.minX + anchor.width / 2, y: anchor.minY + anchor.height / 2 };
  const candidates: Array<{ x: number; y: number; score: number }> = [];

  for (const [directionIndex, direction] of preferredDirections.entries()) {
    for (let depth = 0; depth < 4; depth += 1) {
      for (const sideOffset of sideOffsets) {
        let x = anchor.maxX + xGap + depth * xStep;
        let y = anchor.minY + sideOffset * yStep;
        if (direction === "left") {
          x = anchor.minX - size.w - xGap - depth * xStep;
        } else if (direction === "below") {
          x = anchor.minX + sideOffset * xStep;
          y = anchor.maxY + yGap + depth * yStep;
        } else if (direction === "above") {
          x = anchor.minX + sideOffset * xStep;
          y = anchor.minY - size.h - yGap - depth * yStep;
        } else if (direction === "summary") {
          x = anchor.maxX + xGap + depth * xStep;
          y = anchor.maxY + yGap + sideOffset * yStep;
        }

        const rect = { minX: x, minY: y, maxX: x + size.w, maxY: y + size.h };
        if (occupied.some((current) => overlaps(rect, current))) continue;
        const center = { x: x + size.w / 2, y: y + size.h / 2 };
        candidates.push({
          x,
          y,
          score:
            Math.abs(center.x - anchorCenter.x) +
            Math.abs(center.y - anchorCenter.y) +
            directionIndex * 2000 +
            depth * 90 +
            crossingCount(rect, segments) * 6000 +
            Math.abs(sideOffset) * 24 +
            Math.abs(sideOffset - layout.order) * 18,
        });
      }
    }
  }

  return candidates.sort((a, b) => a.score - b.score)[0]
    ?? { x: Math.max(anchor.maxX, ...occupied.map((rect) => rect.maxX)) + xGap, y: anchor.minY };
}

function getQueryLayout(shape: SQLTextAreaShape): AgentLayout | null {
  const layout = shape.meta.agentQueryLayout;
  if (!layout || typeof layout !== "object" || Array.isArray(layout)) return null;
  return getAgentLayout({ layout }, shape.props.upstreamShapeIds?.[0] as TLShapeId | undefined ?? null, "right");
}

export function trackAgentQueryLayout(editor: Editor, shapeId: TLShapeId, layout: AgentLayout) {
  const shape = editor.getShape<SQLTextAreaShape>(shapeId);
  if (shape?.type !== "sql-text-area") return;
  editor.updateShape<SQLTextAreaShape>({
    id: shapeId,
    type: "sql-text-area",
    meta: { ...shape.meta, agentQueryLayout: { ...layout } },
  });
  reflowAgentQuery(editor, shapeId);
}

function hasLayoutCollision(editor: Editor, shapeId: TLShapeId) {
  const bounds = editor.getShapePageBounds(shapeId);
  if (!bounds) return false;
  return editor.getCurrentPageShapes().some((other) => {
    if (other.id === shapeId || ["arrow", "agent-chat", "agent-blob"].includes(other.type)) return false;
    // Frames and groups contain their children intentionally.
    if (editor.hasAncestor(shapeId, other.id) || editor.hasAncestor(other.id, shapeId)) return false;
    const otherBounds = editor.getShapePageBounds(other.id);
    return otherBounds && overlaps(bounds, {
      minX: otherBounds.minX - 28,
      minY: otherBounds.minY - 28,
      maxX: otherBounds.maxX + 28,
      maxY: otherBounds.maxY + 28,
    });
  });
}

export function reflowAgentQuery(editor: Editor, shapeId: TLShapeId) {
  const query = editor.getShape<SQLTextAreaShape>(shapeId);
  if (query?.type !== "sql-text-area" || query.isLocked || query.props.isManuallyResized) return;
  const layout = getQueryLayout(query);
  if (!layout) return;
  const bounds = editor.getShapePageBounds(shapeId);
  if (!bounds) return;
  if (hasLayoutCollision(editor, shapeId)) {
    const placement = getAgentPlacement(editor, { ...layout, parentShapeId: shapeId, x: undefined, y: undefined }, shapeId, { w: bounds.w, h: bounds.h }, shapeId);
    const origin = editor.getPointInParentSpace(query, placement);
    editor.updateShape({ id: shapeId, type: query.type, x: origin.x, y: origin.y });
  }
  const resultId = query.props.linkedTableId as TLShapeId | null;
  const result = resultId ? editor.getShape(resultId) : null;
  const resultBounds = resultId ? editor.getShapePageBounds(resultId) : null;
  if (result?.type === "sql-result-table" && !result.isLocked && resultBounds && hasLayoutCollision(editor, result.id)) {
    const placement = getAgentPlacement(editor, { parentShapeId: shapeId, placement: "below", order: layout.order }, shapeId, { w: resultBounds.w, h: resultBounds.h }, result.id);
    const origin = editor.getPointInParentSpace(result, placement);
    editor.updateShape({ id: result.id, type: result.type, x: origin.x, y: origin.y });
  }
}

export function registerAgentQueryReflow(editor: Editor) {
  return editor.sideEffects.registerAfterChangeHandler("shape", (previous, next) => {
    if (previous.type === "sql-result-table" && next.type === "sql-result-table") {
      const before = previous.props as { w: number; h: number };
      const after = next.props as { w: number; h: number; sourceShapeId: string };
      if (after.w <= before.w && after.h <= before.h) return;
      editor.run(() => reflowAgentQuery(editor, after.sourceShapeId as TLShapeId), { history: "ignore" });
      return;
    }
    if (previous.type !== "sql-text-area" || next.type !== "sql-text-area") return;
    const before = previous as SQLTextAreaShape;
    const after = next as SQLTextAreaShape;
    if (before.props.w === after.props.w && before.props.h === after.props.h) return;
    if (after.props.w <= before.props.w && after.props.h <= before.props.h) return;
    editor.run(() => reflowAgentQuery(editor, after.id), { history: "ignore" });
  });
}
