import type { Editor, TLShapeId } from "tldraw";
import type { SQLTextAreaShape } from "../SQLTextArea/sql-text-area-types";

export type AgentPlacement = "right" | "below" | "above" | "summary";

export type AgentLayout = {
  parentShapeId: TLShapeId | null;
  order: number;
  placement: AgentPlacement;
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
  };
}

function overlaps(a: LayoutRect, b: LayoutRect) {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
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
    if (previous.type !== "sql-text-area" || next.type !== "sql-text-area") return;
    const before = previous as SQLTextAreaShape;
    const after = next as SQLTextAreaShape;
    if (before.props.w === after.props.w && before.props.h === after.props.h) return;
    if (after.props.w <= before.props.w && after.props.h <= before.props.h) return;
    editor.run(() => reflowAgentQuery(editor, after.id), { history: "ignore" });
  });
}
