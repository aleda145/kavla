import ELK, { type ElkExtendedEdge, type ElkNode } from "elkjs/lib/elk-api";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";
import { getArrowBindings, type Editor, type TLArrowShape, type TLShape, type TLShapeId } from "tldraw";
import type { DataSourceShape } from "../../DataSource/data-source-types";
import type { SQLTextAreaShape } from "../../SQLTextArea/sql-text-area-types";
import type { KnobShape } from "../../Knob/knob-types";
import type { ChartShape } from "../../Chart/chart-shape-types";
import type { SQLResultTableShape } from "../../SQLResultArea/sql-result-table-types";
import type { LensShape } from "../../Lens/lens-shape-types";
import type { SummaryShape } from "../../Summary/summary-shape-types";
import { layoutQueryBranches, type LayoutConnection, type LayoutDirection } from "./layoutQueryBranches";
import { avoidLayoutArrows } from "./avoidLayoutArrows";
import { captureLayoutAnnotations, findEmptyPosition } from "./layoutAnnotations";
import { resetConnectorLanes, routeConnectorLanes } from "./connectorLanes";
import { getLayoutSelection, isLayoutNode } from "./layoutSelection";

function isQueryView(shape: TLShape): shape is ChartShape | SQLResultTableShape | LensShape {
  return ["chart-shape", "sql-result-table", "lens-shape"].includes(shape.type);
}

type LayoutGroup = {
  direction: LayoutDirection;
  width: number;
  height: number;
  offsets: Map<TLShapeId, { x: number; y: number }>;
};

export async function layoutKavlaNodes(editor: Editor, selection = editor.getSelectedShapeIds()): Promise<void> {
  if (editor.getIsReadonly()) return;
  const pageId = editor.getCurrentPageId();
  const shapes = editor.getCurrentPageShapes();
  const selectedShapes = getLayoutSelection(editor, selection);
  const nodes = selectedShapes.filter(isLayoutNode);
  if (nodes.length < 2) return;
  const nodeIds = new Set(nodes.map((shape) => shape.id));
  const allNodes = shapes.filter(isLayoutNode);
  const moveAnnotations = captureLayoutAnnotations(editor, selectedShapes, allNodes);

  const bounds = new Map(
    nodes.map((shape) => {
      const box = editor.getShapePageBounds(shape);
      if (!box) throw new Error(`Cannot measure node ${shape.id}.`);
      return [shape.id, box] as const;
    })
  );
  const shapesById = new Map(shapes.map((shape) => [shape.id, shape]));
  const queryByTable = new Map<TLShapeId, TLShapeId>();
  for (const shape of shapes) {
    if (shape.type !== "sql-text-area") continue;
    const tableId = (shape as SQLTextAreaShape).props.linkedTableId;
    if (tableId) queryByTable.set(tableId as TLShapeId, shape.id);
  }

  const getQueryForView = (view: TLShape): TLShapeId | undefined => {
    let current: TLShape | undefined = view;
    const visited = new Set<TLShapeId>();
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      if (current.type === "sql-text-area") return current.id;
      if (!isQueryView(current)) return;
      const source: string | null = current.props.sourceShapeId;
      // Some older documents only have the query's linkedTableId reference.
      const sourceId: TLShapeId | undefined =
        source && shapesById.has(source as TLShapeId)
          ? (source as TLShapeId)
          : current.type === "sql-result-table"
            ? queryByTable.get(current.id)
            : undefined;
      current = sourceId ? shapesById.get(sourceId) : undefined;
    }
  };

  // These groups exist only for layout. Canvas parents and saved shapes stay independent.
  const groupByShape = new Map<TLShapeId, TLShapeId>();
  const membersByGroup = new Map<TLShapeId, TLShape[]>();
  for (const shape of nodes) {
    const queryId = isQueryView(shape) ? getQueryForView(shape) : undefined;
    // Queries outside the movable selection stay put, so their selected views
    // remain standalone layout nodes.
    const groupId = queryId && bounds.has(queryId) ? queryId : shape.id;
    groupByShape.set(shape.id, groupId);
    const members = membersByGroup.get(groupId) ?? [];
    members.push(shape);
    membersByGroup.set(groupId, members);
  }

  const groups = new Map<TLShapeId, LayoutGroup>();
  const viewGap = 40;
  const makeGroupNode = (id: string, direction: LayoutDirection): ElkNode => {
    const groupId = id as TLShapeId;
    const members = membersByGroup.get(groupId)!;
    const vertical = direction === "DOWN" || direction === "UP";
    const reverse = direction === "LEFT" || direction === "UP";
    // Work in flow/cross-flow coordinates, then transpose back to page axes.
    // Only positions change; charts and tables keep their original dimensions.
    const size = (id: TLShapeId) => {
      const box = bounds.get(id)!;
      return vertical ? { w: box.h, h: box.w } : box;
    };
    const anchor = size(groupId);
    const charts = members.filter((shape) => shape.id !== groupId && shape.type !== "sql-result-table");
    const tables = members.filter((shape) => shape.id !== groupId && shape.type === "sql-result-table");
    const measureRow = (row: TLShape[]) => {
      const axis = vertical ? "y" : "x";
      row.sort(
        (a, b) => (bounds.get(a.id)![axis] - bounds.get(b.id)![axis]) * (reverse ? -1 : 1) || a.id.localeCompare(b.id)
      );
      return {
        width: row.reduce((width, shape) => width + size(shape.id).w, 0) + Math.max(0, row.length - 1) * viewGap,
        height: Math.max(0, ...row.map((shape) => size(shape.id).h)),
      };
    };
    const above = measureRow(charts);
    const below = measureRow(tables);
    const width = Math.max(anchor.w, above.width, below.width);
    const queryY = charts.length ? above.height + viewGap : 0;
    const tableY = queryY + anchor.h + viewGap;
    const offsets = new Map<TLShapeId, { x: number; y: number }>([[groupId, { x: (width - anchor.w) / 2, y: queryY }]]);
    let chartX = (width - above.width) / 2;
    for (const chart of charts) {
      const box = size(chart.id);
      offsets.set(chart.id, { x: chartX, y: above.height - box.h });
      chartX += box.w + viewGap;
    }
    let tableX = (width - below.width) / 2;
    for (const table of tables) {
      offsets.set(table.id, { x: tableX, y: tableY });
      tableX += size(table.id).w + viewGap;
    }
    const height = tables.length ? tableY + below.height : queryY + anchor.h;
    for (const [shapeId, offset] of offsets) {
      const box = size(shapeId);
      const x = reverse ? width - offset.x - box.w : offset.x;
      const y = reverse ? height - offset.y - box.h : offset.y;
      offsets.set(shapeId, vertical ? { x: y, y: x } : { x, y });
    }
    groups.set(groupId, {
      direction,
      width: vertical ? height : width,
      height: vertical ? width : height,
      offsets,
    });
    return { id, width: vertical ? height : width, height: vertical ? width : height };
  };

  const edges = new Map<string, ElkExtendedEdge>();
  const connections = new Map<string, LayoutConnection>();
  const addEdge = (from: string, to: string) => {
    const fromGroup = groupByShape.get(from as TLShapeId);
    const toGroup = groupByShape.get(to as TLShapeId);
    if (!fromGroup || !toGroup || fromGroup === toGroup) return;
    const id = JSON.stringify([fromGroup, toGroup]);
    connections.set(id, { from: fromGroup, to: toGroup });
    edges.set(id, { id, sources: [fromGroup], targets: [toGroup] });
  };

  for (const shape of shapes) {
    if (shape.type === "arrow") {
      const { start, end } = getArrowBindings(editor, shape as TLArrowShape);
      if (start && end) addEdge(start.toId, end.toId);
    } else if (shape.type === "data-source" || shape.type === "sql-text-area" || shape.type === "knob") {
      const props = (shape as DataSourceShape | SQLTextAreaShape | KnobShape).props;
      for (const id of props.upstreamShapeIds ?? []) addEdge(id, shape.id);
      for (const id of props.downstreamShapeIds ?? []) addEdge(shape.id, id);
      if (shape.type === "sql-text-area") {
        const resultId = (shape as SQLTextAreaShape).props.linkedTableId;
        if (resultId) addEdge(shape.id, resultId);
      }
    } else if (isQueryView(shape)) {
      const { sourceShapeId } = shape.props;
      if (sourceShapeId) addEdge(sourceShapeId, shape.id);
    } else if (shape.type === "summary-shape") {
      for (const artifact of (shape as SummaryShape).props.artifacts) addEdge(artifact.shapeId, shape.id);
    }
  }

  const graph: ElkNode = {
    id: "kavla-layout",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.spacing.nodeNode": "80",
      "elk.layered.spacing.nodeNodeBetweenLayers": "120",
      "elk.spacing.componentComponent": "120",
      "elk.padding": "[top=0,left=0,bottom=0,right=0]",
    },
    children: [...membersByGroup.keys()].map((id) => makeGroupNode(id, "RIGHT")),
    edges: [...edges.values()],
  };

  // Run ELK off the UI thread so larger canvases remain responsive.
  const worker = new Worker(elkWorkerUrl);
  const elk = new ELK({ workerFactory: () => worker });
  let layout: ElkNode;
  try {
    layout = await Promise.race([
      layoutQueryBranches(
        elk,
        graph,
        [...connections.values()],
        new Map(shapes.map((shape) => [shape.id, shape.type])),
        makeGroupNode
      ),
      new Promise<never>((_, reject) => {
        worker.addEventListener("error", (event) => reject(new Error(event.message || "Layout worker failed.")), {
          once: true,
        });
      }),
    ]);
  } finally {
    elk.terminateWorker();
  }

  // Don't apply stale positions after a document switch, edit, or query resize.
  if (editor.getIsReadonly() || editor.getCurrentPageId() !== pageId) return;
  if (
    editor.getCurrentPageShapes().length !== shapes.length ||
    shapes.some((shape) => editor.getShape(shape.id) !== shape)
  ) {
    throw new Error("The canvas changed while arranging nodes. Please try Layout again.");
  }

  const originX = Math.min(...[...bounds.values()].map((box) => box.x));
  const originY = Math.min(...[...bounds.values()].map((box) => box.y));
  const deltas = new Map<TLShapeId, { x: number; y: number }>();
  for (const node of layout.children ?? []) {
    const group = groups.get(node.id as TLShapeId);
    if (
      !group ||
      node.x === undefined ||
      node.y === undefined ||
      !Number.isFinite(node.x) ||
      !Number.isFinite(node.y)
    ) {
      throw new Error("Layout returned an invalid node position.");
    }
    for (const [shapeId, offset] of group.offsets) {
      const box = bounds.get(shapeId)!;
      deltas.set(shapeId, {
        x: originX + node.x + offset.x - box.x,
        y: originY + node.y + offset.y - box.y,
      });
    }
  }
  if (deltas.size !== nodes.length) throw new Error("Layout did not return every node.");

  // Keep the arranged selection together and find room around the fixed board.
  // ELK only sees selected nodes, so it cannot reserve this space itself.
  const planned = nodes.map((shape) => {
    const box = bounds.get(shape.id)!;
    const delta = deltas.get(shape.id)!;
    return { x: box.x + delta.x, y: box.y + delta.y, w: box.w, h: box.h };
  });
  const left = Math.min(...planned.map((box) => box.x));
  const top = Math.min(...planned.map((box) => box.y));
  const fixed = shapes.flatMap((shape) => {
    if (nodeIds.has(shape.id) || ["arrow", "group", "frame", "agent-chat"].includes(shape.type)) return [];
    const box = editor.getShapePageBounds(shape);
    return box ? [box] : [];
  });
  const free = findEmptyPosition(
    {
      x: left,
      y: top,
      w: Math.max(...planned.map((box) => box.x + box.w)) - left,
      h: Math.max(...planned.map((box) => box.y + box.h)) - top,
    },
    fixed
  );
  for (const delta of deltas.values()) {
    delta.x += free.x - left;
    delta.y += free.y - top;
  }

  const updates = shapes.flatMap((shape) => {
    const delta = deltas.get(shape.id);
    const parentDelta = deltas.get(shape.parentId as TLShapeId);
    if (!delta && !parentDelta) return [];
    // Keep children fixed during node placement. Selected unlocked annotations
    // follow their chosen node after arrow avoidance has finished.
    const origin = editor.getShapePageTransform(shape).applyToPoint({ x: 0, y: 0 });
    const point = editor.getPointInParentSpace(shape, {
      x: origin.x + (delta?.x ?? 0) - (parentDelta?.x ?? 0),
      y: origin.y + (delta?.y ?? 0) - (parentDelta?.y ?? 0),
    });
    return [{ id: shape.id, type: shape.type, x: point.x, y: point.y }];
  });

  editor.markHistoryStoppingPoint("layout-kavla-nodes");
  editor.run(
    () => {
      editor.updateShapes(updates);
      resetConnectorLanes(editor, nodeIds);

      // Clear endpoint pins and custom bends saved by earlier layout versions.
      // Generated query connectors return to automatic routing; native arrows
      // and query-to-chart/table connections keep their existing bindings.
      for (const shape of shapes) {
        if (shape.type !== "arrow" || shape.meta.kavlaConnector !== true || editor.isShapeOrAncestorLocked(shape.id))
          continue;
        const arrow = editor.getShape<TLArrowShape>(shape.id)!;
        if (arrow.props.kind !== "elbow") continue;
        const { start, end } = getArrowBindings(editor, arrow);
        if (!start || !end) continue;
        if (!nodeIds.has(start.toId) && !nodeIds.has(end.toId)) continue;
        const source = editor.getShape(start.toId);
        const target = editor.getShape(end.toId);
        if (
          !source ||
          target?.type !== "sql-text-area" ||
          !["sql-text-area", "data-source", "knob"].includes(source.type)
        )
          continue;
        editor.updateBindings(
          [start, end].map((binding) => ({
            id: binding.id,
            type: "arrow",
            props: { normalizedAnchor: { x: 0.5, y: 0.5 }, isPrecise: false, isExact: false, snap: "none" },
          }))
        );
        editor.updateShape<TLArrowShape>({
          id: arrow.id,
          type: "arrow",
          props: { elbowMidPoint: 0.5 },
        });
      }
      avoidLayoutArrows(
        editor,
        new Map([...groupByShape].filter(([id, groupId]) => id !== groupId && isQueryView(shapesById.get(id)!))),
        new Set(
          shapes
            .filter((shape) => !["arrow", "group", "frame", "agent-chat"].includes(shape.type))
            .map((shape) => shape.id)
        ),
        new Map(
          [...groups].map(([id, group]) => [id, { direction: group.direction, members: [...group.offsets.keys()] }])
        )
      );
      moveAnnotations();
      routeConnectorLanes(editor, nodeIds);
    },
    { ignoreShapeLock: true }
  );
  editor.markHistoryStoppingPoint("layout-kavla-nodes-complete");
}
