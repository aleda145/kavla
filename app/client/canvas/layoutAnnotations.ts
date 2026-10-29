import {
  defaultShapeSchemas,
  getArrowBindings,
  getArrowInfo,
  type Editor,
  type TLArrowShape,
  type TLShape,
  type TLShapeId,
} from "tldraw";

type Bounds = { x: number; y: number; w: number; h: number };

function findEmptyPosition(preferred: Bounds, obstacles: Bounds[]): { x: number; y: number } {
  const gap = 16;
  const overlaps = (point: { x: number; y: number }, box: Bounds) =>
    point.x < box.x + box.w + gap &&
    point.x + preferred.w + gap > box.x &&
    point.y < box.y + box.h + gap &&
    point.y + preferred.h + gap > box.y;
  const distance = (point: { x: number; y: number }) => (point.x - preferred.x) ** 2 + (point.y - preferred.y) ** 2;
  const pending = [{ x: preferred.x, y: preferred.y }];
  const visited = new Set<string>();
  // Try nearby edges first. Bound the search so crowded boards stay responsive.
  for (let attempt = 0; pending.length && attempt < 128; attempt++) {
    pending.sort((a, b) => distance(a) - distance(b));
    const point = pending.shift()!;
    const blocker = obstacles.find((box) => overlaps(point, box));
    if (!blocker) return point;
    for (const next of [
      { x: blocker.x - preferred.w - gap, y: point.y },
      { x: blocker.x + blocker.w + gap, y: point.y },
      { x: point.x, y: blocker.y - preferred.h - gap },
      { x: point.x, y: blocker.y + blocker.h + gap },
    ]) {
      const key = `${next.x},${next.y}`;
      if (visited.has(key)) continue;
      visited.add(key);
      pending.push(next);
    }
  }
  // If the local search is crowded, use the nearest clear outer edge rather
  // than leaving an annotation on top of something. The canvas is infinite.
  const outside = [
    { x: Math.min(...obstacles.map((box) => box.x)) - preferred.w - gap, y: preferred.y },
    { x: Math.max(...obstacles.map((box) => box.x + box.w)) + gap, y: preferred.y },
    { x: preferred.x, y: Math.min(...obstacles.map((box) => box.y)) - preferred.h - gap },
    { x: preferred.x, y: Math.max(...obstacles.map((box) => box.y + box.h)) + gap },
  ];
  return outside.sort((a, b) => distance(a) - distance(b))[0];
}

// Capture proximity before layout; apply only after the nodes finish moving.
// Annotations don't reserve space or influence the analytics layout.
export function captureLayoutAnnotations(editor: Editor, shapes: TLShape[], nodes: TLShape[]): () => void {
  const anchors = nodes.flatMap((node) => {
    const box = editor.getShapePageBounds(node);
    return box ? [{ id: node.id, box, origin: editor.getShapePageTransform(node).applyToPoint({ x: 0, y: 0 }) }] : [];
  });
  const eligible = new Set<TLShapeId>();
  for (const shape of shapes) {
    if (!Object.hasOwn(defaultShapeSchemas, shape.type) || editor.isShapeOrAncestorLocked(shape)) continue;
    if (shape.type === "arrow") {
      const bindings = getArrowBindings(editor, shape as TLArrowShape);
      if (shape.meta.kavlaConnector || bindings.start || bindings.end) continue;
    }
    eligible.add(shape.id);
  }
  // Keep native groups together, but don't carry locked shapes or analytics
  // nodes along by moving their container. Their eligible children can follow.
  for (const shape of shapes) {
    if (shape.type !== "group" && shape.type !== "frame") continue;
    if ([...editor.getShapeAndDescendantIds([shape.id])].some((id) => !eligible.has(id))) {
      eligible.delete(shape.id);
    }
  }
  const attachments = shapes.flatMap((shape) => {
    if (!eligible.has(shape.id)) return [];
    let parent = editor.getShape(shape.parentId);
    while (parent) {
      if (eligible.has(parent.id)) return [];
      parent = editor.getShape(parent.parentId);
    }
    const box = editor.getShapePageBounds(shape);
    if (!box) return [];
    let nearest: (typeof anchors)[number] | undefined;
    let bestGap = 240;
    let bestCenter = Infinity;
    for (const anchor of anchors) {
      // Actual parenting is a stronger hint than proximity.
      if (editor.hasAncestor(shape, anchor.id)) {
        nearest = anchor;
        break;
      }
      const other = anchor.box;
      const gap = Math.hypot(
        Math.max(0, box.x - other.maxX, other.x - box.maxX),
        Math.max(0, box.y - other.maxY, other.y - box.maxY)
      );
      const center = Math.hypot(box.center.x - other.center.x, box.center.y - other.center.y);
      if (gap < bestGap || (gap === bestGap && center < bestCenter)) {
        nearest = anchor;
        bestGap = gap;
        bestCenter = center;
      }
    }
    return nearest
      ? [{ shape, box, anchor: nearest, origin: editor.getShapePageTransform(shape).applyToPoint({ x: 0, y: 0 }) }]
      : [];
  });

  return () => {
    for (const { shape, box, anchor, origin } of attachments) {
      if (!editor.getShape(shape.id) || !editor.getShape(anchor.id) || editor.isShapeOrAncestorLocked(shape.id))
        continue;
      const position = editor.getShapePageTransform(anchor.id).applyToPoint({ x: 0, y: 0 });
      const dx = position.x - anchor.origin.x;
      const dy = position.y - anchor.origin.y;
      const descendants = editor.getShapeAndDescendantIds([shape.id]);
      const obstacles = editor.getCurrentPageShapes().flatMap<Bounds>((other) => {
        if (descendants.has(other.id)) return [];
        if (!Object.hasOwn(defaultShapeSchemas, other.type) && !nodes.some((node) => node.id === other.id)) return [];
        // A containing frame/group is a container, not an occupied surface.
        if ((other.type === "frame" || other.type === "group") && editor.hasAncestor(shape, other.id)) return [];
        if (other.type === "arrow") {
          const arrow = other as TLArrowShape;
          const { start, end } = getArrowBindings(editor, arrow);
          if ((start && descendants.has(start.toId)) || (end && descendants.has(end.toId))) return [];
          const info = getArrowInfo(editor, arrow);
          if (info?.type === "elbow" || info?.type === "straight") {
            // Reserve the individual segments, not the empty area inside a bend.
            const transform = editor.getShapePageTransform(arrow);
            const points = (info.type === "elbow" ? info.route.points : [info.start.point, info.end.point]).map(
              (point) => transform.applyToPoint(point)
            );
            return points.slice(1).map((point, i) => ({
              x: Math.min(point.x, points[i].x),
              y: Math.min(point.y, points[i].y),
              w: Math.abs(point.x - points[i].x),
              h: Math.abs(point.y - points[i].y),
            }));
          }
        }
        const bounds = editor.getShapePageBounds(other);
        return bounds ? [bounds] : [];
      });
      const free = findEmptyPosition({ x: box.x + dx, y: box.y + dy, w: box.w, h: box.h }, obstacles);
      const local = editor.getPointInParentSpace(shape.id, {
        x: origin.x + free.x - box.x,
        y: origin.y + free.y - box.y,
      });
      // Place sequentially so later annotations also avoid ones just placed.
      editor.updateShape({ id: shape.id, type: shape.type, x: local.x, y: local.y });
    }
  };
}
