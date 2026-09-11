import type { Editor, TLShapeId } from "tldraw";

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
    .filter((shape) => shape.id !== movingShapeId && shape.type !== "arrow" && shape.type !== "codex-agent")
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

  return candidates.sort((a, b) => a.score - b.score)[0] ?? { x: anchor.maxX + xGap, y: anchor.minY };
}
