import {
  getArrowBindings,
  STROKE_SIZES,
  track,
  useEditor,
  useValue,
  type Editor,
  type TLArrowShape,
  type TLShape,
  type TLShapeId,
} from "tldraw";
import type { DataSourceShape } from "../../DataSource/data-source-types";
import type { SQLTextAreaShape } from "../../SQLTextArea/sql-text-area-types";
import type { KnobShape } from "../../Knob/knob-types";
import type { ChartShape } from "../../Chart/chart-shape-types";
import type { SQLResultTableShape } from "../../SQLResultArea/sql-result-table-types";
import type { LensShape } from "../../Lens/lens-shape-types";

interface LineageEdge {
  from: TLShapeId;
  to: TLShapeId;
  arrowId?: TLShapeId;
}

function getLineageColor(shape: TLShape | undefined): string {
  // Use the node header's color family, at 300 weight so the glow reads on white.
  switch (shape?.type) {
    case "data-source":
      return "#93c5fd";
    case "chart-shape":
    case "lens-shape":
      return "#f9a8d4";
    case "sql-result-table":
      return "#86efac";
    case "knob":
    case "summary-shape":
      return "#5eead4";
    default:
      return "#fde047";
  }
}

function getLineageShapeIds(editor: Editor): Set<TLShapeId> {
  const selectedIds = new Set(editor.getSelectedShapeIds());
  const highlightedIds = new Set<TLShapeId>();
  if (selectedIds.size === 0) return highlightedIds;

  const shapes = editor.getCurrentPageShapes();
  const pageIds = new Set(shapes.map((shape) => shape.id));
  const upstream = new Map<TLShapeId, LineageEdge[]>();
  const downstream = new Map<TLShapeId, LineageEdge[]>();
  const upstreamSeeds = new Set(selectedIds);
  const downstreamSeeds = new Set(selectedIds);

  function addEdge(from: TLShapeId, to: TLShapeId, arrowId?: TLShapeId) {
    // Older documents may retain references to deleted shapes.
    if (!pageIds.has(from) || !pageIds.has(to) || from === to) return;
    const edge = { from, to, arrowId };
    const outgoing = downstream.get(from) ?? [];
    outgoing.push(edge);
    downstream.set(from, outgoing);
    const incoming = upstream.get(to) ?? [];
    incoming.push(edge);
    upstream.set(to, incoming);
  }

  for (const shape of shapes) {
    if (shape.type === "arrow") {
      const bindings = getArrowBindings(editor, shape as TLArrowShape);
      const from = bindings.start?.toId;
      const to = bindings.end?.toId;
      if (from && to) {
        addEdge(from, to, shape.id);
        if (selectedIds.has(shape.id)) {
          upstreamSeeds.add(from);
          downstreamSeeds.add(to);
        }
      }
    } else if (shape.type === "data-source" || shape.type === "sql-text-area" || shape.type === "knob") {
      const { upstreamShapeIds, downstreamShapeIds } = (shape as DataSourceShape | SQLTextAreaShape | KnobShape).props;
      for (const id of upstreamShapeIds ?? []) addEdge(id as TLShapeId, shape.id);
      for (const id of downstreamShapeIds ?? []) addEdge(shape.id, id as TLShapeId);
    } else if (shape.type === "chart-shape" || shape.type === "sql-result-table" || shape.type === "lens-shape") {
      const { sourceShapeId } = (shape as ChartShape | SQLResultTableShape | LensShape).props;
      if (sourceShapeId) addEdge(sourceShapeId as TLShapeId, shape.id);
    }
  }

  function walk(seeds: Set<TLShapeId>, edges: Map<TLShapeId, LineageEdge[]>, direction: "from" | "to") {
    const visited = new Set(seeds);
    const pending = [...seeds];
    for (const id of seeds) highlightedIds.add(id);
    for (let index = 0; index < pending.length; index++) {
      for (const edge of edges.get(pending[index]) ?? []) {
        const nextId = edge[direction];
        highlightedIds.add(nextId);
        if (edge.arrowId) highlightedIds.add(edge.arrowId);
        if (!visited.has(nextId)) {
          visited.add(nextId);
          pending.push(nextId);
        }
      }
    }
  }

  // Keep the walks separate: an ancestor's other outputs and a descendant's
  // other inputs are not part of the selected node's lineage.
  walk(upstreamSeeds, upstream, "from");
  walk(downstreamSeeds, downstream, "to");
  return highlightedIds;
}

// Shape indicators may use hooks, so give each one its own component.
const LineageOutline = track(function LineageOutline({ shape }: { shape: TLShape }) {
  const editor = useEditor();
  return editor.getShapeUtil(shape).indicator(shape);
});

const LineageHighlight = track(function LineageHighlight({ shapeId }: { shapeId: TLShapeId }) {
  const editor = useEditor();
  const shape = editor.getShape(shapeId);
  if (!shape) return null;

  let colorShape = shape;
  let arrowStrokeWidth: number | undefined;
  if (shape.type === "arrow") {
    const arrow = shape as TLArrowShape;
    const upstreamId = getArrowBindings(editor, arrow).start?.toId;
    colorShape = (upstreamId && editor.getShape(upstreamId)) || shape;

    const zoom = editor.getZoomLevel();
    const normalWidth = STROKE_SIZES[arrow.props.size] * arrow.props.scale;
    // Clamp the added emphasis in screen pixels, while following the original
    // stroke at high zoom so the highlight never disappears underneath it.
    const extraScreenWidth = Math.min(1.25, Math.max(0.5, zoom));
    arrowStrokeWidth = Math.max(1, normalWidth * zoom + extraScreenWidth) / zoom;
  }

  return (
    <svg
      className={`tl-overlays__item kavla-lineage-highlight${shape.type === "arrow" ? " kavla-lineage-arrow" : ""}`}
      aria-hidden="true"
      style={{
        transform: editor.getShapePageTransform(shape).toCssString(),
        clipPath: editor.getShapeClipPath(shape),
        color: getLineageColor(colorShape),
      }}
    >
      <g className="kavla-lineage-outline" style={{ strokeWidth: arrowStrokeWidth }}>
        <LineageOutline shape={shape} />
      </g>
    </svg>
  );
});

export function LineageHighlights() {
  const editor = useEditor();
  const lineageIds = useValue("Selected shape lineage", () => getLineageShapeIds(editor), [editor]);
  const visibleIds = useValue(
    "Visible lineage shapes",
    () => {
      const culledIds = editor.getCulledShapes();
      return [...lineageIds].filter((id) => !culledIds.has(id) && !editor.isShapeHidden(id));
    },
    [editor, lineageIds]
  );

  return visibleIds.map((shapeId) => <LineageHighlight key={shapeId} shapeId={shapeId} />);
}
