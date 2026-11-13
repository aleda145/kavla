import { track, useEditor, useValue } from "tldraw";
import type { SQLTextAreaShape } from "../../SQLTextArea/sql-text-area-types";
import { getAutoPlacementSearch } from "./autoPlacement";
import { readRoute } from "./arrowGeometry";

export const AutoPlacementDebug = track(function AutoPlacementDebug() {
  const editor = useEditor();
  // Cache the geometry search independently of zoom and pan. This preview only
  // reads the board; it never moves shapes or probes live arrow bindings.
  const circles = useValue(
    "Selected nodes' placement search",
    () => {
      if (!editor.getInstanceState().isDebugMode) return [];
      const parents = editor
        .getSelectedShapes()
        .filter((shape) => shape.type === "data-source" || shape.type === "sql-text-area");
      if (!parents.length) return [];
      const child = editor.getShapeUtil<SQLTextAreaShape>("sql-text-area").getDefaultProps();
      const shapes = editor.getCurrentPageShapes();
      const obstacles = shapes.flatMap((shape) => {
        if (["arrow", "group", "frame", "agent-chat", "agent-blob"].includes(shape.type)) return [];
        const bounds = editor.getShapePageBounds(shape);
        return bounds ? [bounds] : [];
      });
      const routes = shapes.flatMap((shape) => {
        const route = shape.type === "arrow" ? readRoute(editor, shape.id) : undefined;
        return route ? [route] : [];
      });
      return parents.flatMap((shape) => {
        const bounds = editor.getShapePageBounds(shape);
        if (!bounds) return [];
        const { initialRadius, radius } = getAutoPlacementSearch(bounds, child, obstacles, routes, 120);
        return [{ id: shape.id, x: bounds.center.x, y: bounds.center.y, initialRadius, radius }];
      });
    },
    [editor]
  );
  if (!circles.length) return null;
  const zoom = editor.getZoomLevel();
  return circles.map(({ id, x, y, initialRadius, radius }) => {
    return (
      <svg
        key={id}
        className="tl-overlays__item"
        aria-hidden="true"
        style={{ pointerEvents: "none", overflow: "visible", color: "#0d9488" }}
      >
        <g fill="none" stroke="currentColor" strokeWidth={2 / zoom}>
          <circle cx={x} cy={y} r={radius} />
          {radius > initialRadius && (
            <circle cx={x} cy={y} r={initialRadius} strokeDasharray={`${6 / zoom} ${6 / zoom}`} opacity={0.6} />
          )}
          <circle cx={x} cy={y} r={4 / zoom} fill="currentColor" />
        </g>
        <text
          x={x}
          y={y - radius - 10 / zoom}
          textAnchor="middle"
          fontSize={12 / zoom}
          fontFamily="monospace"
          fill="currentColor"
          stroke="var(--color-background)"
          strokeWidth={4 / zoom}
          paintOrder="stroke"
        >
          New query · search radius {Math.round(radius)} · node centers
        </text>
      </svg>
    );
  });
});
