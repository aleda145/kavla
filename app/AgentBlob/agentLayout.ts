import type { Editor, TLArrowBinding, TLShapeId } from "tldraw";
import type { SQLTextAreaShape } from "../SQLTextArea/sql-text-area-types";

export type AgentPlacement = "right" | "below" | "above" | "summary";

export type AgentLayout = {
  parentShapeId: TLShapeId | null;
  order: number;
  placement: AgentPlacement;
  branch?: string;
  role?: "analysis" | "diagnostic";
  rootShapeId?: TLShapeId;
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
  const rawOrder = typeof layout.order === "number" && Number.isFinite(layout.order) ? layout.order : 0;
  return {
    parentShapeId: typeof layout.parentShapeId === "string"
      ? layout.parentShapeId as TLShapeId
      : fallbackParentShapeId,
    order: Math.max(0, Math.min(20, rawOrder)),
    placement: ["right", "below", "above", "summary"].includes(placement)
      ? placement as AgentPlacement
      : defaultPlacement,
    ...(typeof layout.branch === "string" && layout.branch.trim() ? { branch: layout.branch.trim() } : {}),
    ...(layout.role === "analysis" || layout.role === "diagnostic" ? { role: layout.role } : {}),
    ...(typeof layout.rootShapeId === "string" ? { rootShapeId: layout.rootShapeId as TLShapeId } : {}),
  };
}

function overlaps(a: LayoutRect, b: LayoutRect) {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

// The analyst chooses semantic branches; the browser owns their geometry.
export function getAgentQueryLayout(editor: Editor, args: Record<string, unknown>, sourceShapeId: TLShapeId): AgentLayout {
  const source = editor.getShape<SQLTextAreaShape>(sourceShapeId);
  const inherited = source?.type === "sql-text-area" ? getQueryLayout(source) : null;
  const layout = getAgentLayout(args, sourceShapeId, "below");
  const role = layout.role ?? inherited?.role ?? "analysis";
  return {
    ...layout,
    parentShapeId: sourceShapeId,
    rootShapeId: inherited?.rootShapeId ?? sourceShapeId,
    role,
    branch: layout.branch ?? (role === inherited?.role ? inherited.branch : role === "diagnostic" ? "diagnostics" : "main"),
  };
}

function arrowCorridors(editor: Editor, excluded: Set<TLShapeId>): LayoutRect[] {
  return editor.getCurrentPageShapes().filter((shape) => shape.type === "arrow").flatMap((arrow) => {
    if (editor.getBindingsFromShape<TLArrowBinding>(arrow, "arrow").some((binding) => excluded.has(binding.toId))) return [];
    const transform = editor.getShapePageTransform(arrow);
    const points = editor.getShapeGeometry(arrow).vertices.map((point) => transform.applyToPoint(point));
    return points.slice(1).map((point, index) => ({
      minX: Math.min(point.x, points[index].x) - 18,
      minY: Math.min(point.y, points[index].y) - 18,
      maxX: Math.max(point.x, points[index].x) + 18,
      maxY: Math.max(point.y, points[index].y) + 18,
    }));
  });
}

export function getAgentQueryPlacement(
  editor: Editor,
  layout: AgentLayout,
  size: { w: number; h: number },
  movingShapeId: TLShapeId | null = null,
  inputShapeIds: TLShapeId[] = [],
) {
  const queries = editor.getCurrentPageShapes().filter((shape): shape is SQLTextAreaShape => shape.type === "sql-text-area");
  const moving = movingShapeId ? editor.getShape<SQLTextAreaShape>(movingShapeId) : null;
  const excluded = new Set<TLShapeId>();
  if (moving) {
    excluded.add(moving.id);
    if (moving.props.linkedTableId && !editor.getShape(moving.props.linkedTableId as TLShapeId)?.isLocked) excluded.add(moving.props.linkedTableId as TLShapeId);
    // Expanding a parent pushes its descendants down, rather than jumping past them.
    const downstream = new Set<TLShapeId>([moving.id]);
    for (const id of downstream) {
      for (const query of queries) {
        if (downstream.has(query.id)) continue;
        if (query.props.upstreamShapeIds?.includes(id) || getQueryLayout(query)?.parentShapeId === id) {
          if (!query.isLocked && !query.props.isManuallyResized && getQueryLayout(query)?.branch) {
            downstream.add(query.id);
            excluded.add(query.id);
            if (query.props.linkedTableId && !editor.getShape(query.props.linkedTableId as TLShapeId)?.isLocked) excluded.add(query.props.linkedTableId as TLShapeId);
          }
        }
      }
    }
  }
  const rootBounds = layout.rootShapeId ? editor.getShapePageBounds(layout.rootShapeId) : null;
  const parentBounds = layout.parentShapeId ? editor.getShapePageBounds(layout.parentShapeId) : null;
  const origin = rootBounds ?? parentBounds;
  const resultBounds = moving?.props.linkedTableId ? editor.getShapePageBounds(moving.props.linkedTableId as TLShapeId) : null;
  const pairWidth = Math.max(size.w, 600) + 80 + Math.max(resultBounds?.w ?? 400, 400);
  const pairHeight = Math.max(size.h, resultBounds?.h ?? 300);
  const branchQueries = queries.filter((query) => {
    const other = getQueryLayout(query);
    return other?.rootShapeId === layout.rootShapeId && other?.branch === layout.branch && other?.role === layout.role;
  });
  let x = origin?.minX ?? editor.getViewportPageBounds().center.x;
  const existing = branchQueries.find((query) => query.id !== movingShapeId);
  if (moving) x = editor.getShapePageBounds(moving.id)?.minX ?? x;
  else if (existing) x = editor.getShapePageBounds(existing.id)?.minX ?? x;
  else {
    const lanes = queries.filter((query) => getQueryLayout(query)?.rootShapeId === layout.rootShapeId)
      .flatMap((query) => {
        const bounds = editor.getShapePageBounds(query.id);
        const table = query.props.linkedTableId ? editor.getShapePageBounds(query.props.linkedTableId as TLShapeId) : null;
        return bounds ? [{ minX: bounds.minX, maxX: Math.max(bounds.minX + 1080, table?.maxX ?? bounds.maxX) }] : [];
      });
    if (layout.role === "diagnostic") x = Math.min(x, ...lanes.map((lane) => lane.minX)) - pairWidth - 180;
    else if (layout.branch !== "main") x = Math.max(x + 1080, ...lanes.map((lane) => lane.maxX)) + 180;
  }
  let y = (parentBounds?.maxY ?? origin?.maxY ?? editor.getViewportPageBounds().center.y) + 140;
  if (moving) y = Math.max(y, editor.getShapePageBounds(moving.id)?.minY ?? y);
  const inputs = new Set(inputShapeIds.concat(layout.parentShapeId ? [layout.parentShapeId] : []));
  const predecessors = queries.filter((query) => inputs.has(query.id) || (moving
    ? moving.props.upstreamShapeIds?.includes(query.id)
    : branchQueries.includes(query)));
  for (const query of predecessors) {
    if (excluded.has(query.id)) continue;
    const bounds = editor.getShapePageBounds(query.id);
    const table = query.props.linkedTableId ? editor.getShapePageBounds(query.props.linkedTableId as TLShapeId) : null;
    y = Math.max(y, (bounds?.maxY ?? y - 140) + 140, (table?.maxY ?? y - 140) + 140);
  }
  const occupied = editor.getCurrentPageShapes()
    .filter((shape) => !excluded.has(shape.id) && !["arrow", "agent-chat", "agent-blob"].includes(shape.type))
    .filter((shape) => !movingShapeId || (!editor.hasAncestor(movingShapeId, shape.id) && !editor.hasAncestor(shape.id, movingShapeId)))
    .flatMap((shape) => {
      const bounds = editor.getShapePageBounds(shape.id);
      return bounds ? [{ id: shape.id, minX: bounds.minX - 28, minY: bounds.minY - 28, maxX: bounds.maxX + 28, maxY: bounds.maxY + 28 }] : [];
    });
  const corridors = arrowCorridors(editor, excluded);
  const inputBounds = [...new Set([...inputs, ...(moving?.props.upstreamShapeIds ?? [])])]
    .flatMap((id) => {
      const bounds = editor.getShapePageBounds(id as TLShapeId);
      return bounds ? [{ id, bounds }] : [];
    });
  const candidates: Array<{ x: number; y: number; score: number }> = [];
  const startY = y;
  for (let attempt = 0; attempt < occupied.length + 12; attempt++) {
    const rect = { minX: x, minY: y, maxX: x + pairWidth, maxY: y + pairHeight };
    const blockers = occupied.filter((bounds) => overlaps(rect, bounds));
    if (blockers.length) {
      y = Math.max(...blockers.map((bounds) => bounds.maxY)) + 140;
      continue;
    }
    let crossings = corridors.filter((bounds) => overlaps(rect, bounds)).length;
    // Estimate the incoming elbow paths as well as respecting arrows already drawn.
    for (const input of inputBounds) {
      const fromX = input.bounds.minX + input.bounds.w / 2;
      const toX = x + size.w / 2;
      const midY = (input.bounds.maxY + y) / 2;
      const route = [
        { minX: fromX - 18, maxX: fromX + 18, minY: input.bounds.maxY, maxY: midY },
        { minX: Math.min(fromX, toX) - 18, maxX: Math.max(fromX, toX) + 18, minY: midY - 18, maxY: midY + 18 },
        { minX: toX - 18, maxX: toX + 18, minY: midY, maxY: y },
      ];
      crossings += occupied.filter((bounds) => bounds.id !== input.id && route.some((segment) => overlaps(segment, bounds))).length;
    }
    candidates.push({ x, y, score: crossings * 2000 + y - startY });
    if (!crossings) break;
    y += 140;
  }
  return candidates.sort((a, b) => a.score - b.score)[0] ?? { x, y };
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
  const corridors = arrowCorridors(editor, new Set(movingShapeId ? [movingShapeId] : []));

  const xGap = 70;
  const yGap = 60;
  const xStep = size.w + xGap;
  const yStep = size.h + yGap;
  const sideOffsets = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5];
  const preferredDirections: AgentPlacement[] = layout.placement === "below"
    ? ["below", "right", "above", "summary"]
    : layout.placement === "above"
      ? ["above", "right", "below", "summary"]
      : layout.placement === "summary"
        ? ["summary", "right", "below", "above"]
        : ["right", "below", "above", "summary"];
  const anchorCenter = { x: anchor.minX + anchor.width / 2, y: anchor.minY + anchor.height / 2 };
  const candidates: Array<{ x: number; y: number; score: number }> = [];

  for (const [directionIndex, direction] of preferredDirections.entries()) {
    for (let depth = 0; depth < 4; depth += 1) {
      for (const sideOffset of sideOffsets) {
        let x = anchor.maxX + xGap + depth * xStep;
        let y = anchor.minY + sideOffset * yStep;
        if (direction === "below") {
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
            directionIndex * 220 +
            depth * 90 +
            corridors.filter((corridor) => overlaps(rect, corridor)).length * 2000 +
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
  reflowQuery(editor, shapeId, new Set());
}

function reflowQuery(editor: Editor, shapeId: TLShapeId, visited: Set<TLShapeId>) {
  if (visited.has(shapeId)) return;
  visited.add(shapeId);
  const query = editor.getShape<SQLTextAreaShape>(shapeId);
  if (query?.type !== "sql-text-area" || query.isLocked || query.props.isManuallyResized) return;
  const layout = getQueryLayout(query);
  if (!layout) return;
  const bounds = editor.getShapePageBounds(shapeId);
  if (!bounds) return;
  if (layout.branch && layout.rootShapeId) {
    const placement = getAgentQueryPlacement(editor, layout, { w: bounds.w, h: bounds.h }, shapeId);
    const origin = editor.getPointInParentSpace(query, placement);
    if (query.x !== origin.x || query.y !== origin.y) {
      editor.updateShape({ id: shapeId, type: query.type, x: origin.x, y: origin.y });
    }
    const result = query.props.linkedTableId ? editor.getShape(query.props.linkedTableId as TLShapeId) : null;
    if (result?.type === "sql-result-table" && !result.isLocked) {
      const resultOrigin = editor.getPointInParentSpace(result, { x: placement.x + bounds.w + 80, y: placement.y });
      if (result.x !== resultOrigin.x || result.y !== resultOrigin.y) {
        editor.updateShape({ id: result.id, type: result.type, x: resultOrigin.x, y: resultOrigin.y });
      }
    }
    for (const child of editor.getCurrentPageShapes()) {
      if (child.type !== "sql-text-area") continue;
      const childQuery = child as SQLTextAreaShape;
      if (childQuery.props.upstreamShapeIds?.includes(shapeId) || getQueryLayout(childQuery)?.parentShapeId === shapeId) {
        reflowQuery(editor, child.id, visited);
      }
    }
    visited.delete(shapeId);
    return;
  }
  if (hasLayoutCollision(editor, shapeId)) {
    const placement = getAgentPlacement(editor, layout, layout.parentShapeId, { w: bounds.w, h: bounds.h }, shapeId);
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
