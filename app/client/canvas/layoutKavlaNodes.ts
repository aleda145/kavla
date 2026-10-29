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
import { layoutQueryBranches, type LayoutConnection } from "./layoutQueryBranches";
import { avoidLayoutArrows } from "./avoidLayoutArrows";

// Explicitly opt in: native tldraw shapes and the hidden agent-chat record aren't nodes.
const nodeTypes = new Set([
  "data-source",
  "sql-text-area",
  "sql-result-table",
  "chart-shape",
  "lens-shape",
  "knob",
  "summary-shape",
  "cli-terminal",
  "agent-blob",
]);

export function isLayoutNode(shape: TLShape): boolean {
  return nodeTypes.has(shape.type);
}

function isQueryView(shape: TLShape): shape is ChartShape | SQLResultTableShape | LensShape {
  return ["chart-shape", "sql-result-table", "lens-shape"].includes(shape.type);
}

type LayoutGroup = {
  width: number;
  height: number;
  offsets: Map<TLShapeId, { x: number; y: number }>;
};

export async function layoutKavlaNodes(editor: Editor): Promise<void> {
  if (editor.getIsReadonly()) return;
  const pageId = editor.getCurrentPageId();
  const shapes = editor.getCurrentPageShapes();
  const nodes = shapes.filter((shape) => isLayoutNode(shape) && !editor.isShapeOrAncestorLocked(shape));
  if (nodes.length < 2) return;

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
    // Locked queries aren't moved, so their views remain standalone layout nodes.
    const groupId = queryId && bounds.has(queryId) ? queryId : shape.id;
    groupByShape.set(shape.id, groupId);
    const members = membersByGroup.get(groupId) ?? [];
    members.push(shape);
    membersByGroup.set(groupId, members);
  }

  const groups = new Map<TLShapeId, LayoutGroup>();
  const viewGap = 40;
  for (const [groupId, members] of membersByGroup) {
    const anchor = bounds.get(groupId)!;
    const charts = members.filter((shape) => shape.id !== groupId && shape.type !== "sql-result-table");
    const tables = members.filter((shape) => shape.id !== groupId && shape.type === "sql-result-table");
    const measureRow = (row: TLShape[]) => {
      row.sort((a, b) => bounds.get(a.id)!.x - bounds.get(b.id)!.x || a.id.localeCompare(b.id));
      return {
        width: row.reduce((width, shape) => width + bounds.get(shape.id)!.w, 0) + Math.max(0, row.length - 1) * viewGap,
        height: Math.max(0, ...row.map((shape) => bounds.get(shape.id)!.h)),
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
      const box = bounds.get(chart.id)!;
      offsets.set(chart.id, { x: chartX, y: above.height - box.h });
      chartX += box.w + viewGap;
    }
    let tableX = (width - below.width) / 2;
    for (const table of tables) {
      offsets.set(table.id, { x: tableX, y: tableY });
      tableX += bounds.get(table.id)!.w + viewGap;
    }
    groups.set(groupId, {
      width,
      height: tables.length ? tableY + below.height : queryY + anchor.h,
      offsets,
    });
  }

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
    children: [...groups].map(([id, group]) => ({
      id,
      width: group.width,
      height: group.height,
    })),
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
        new Map(shapes.map((shape) => [shape.id, shape.type]))
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

  const updates = shapes.flatMap((shape) => {
    const delta = deltas.get(shape.id);
    const parentDelta = deltas.get(shape.parentId as TLShapeId);
    if (!delta && !parentDelta) return [];
    // Native annotations can be children of a chart. Counteract the parent's
    // translation to keep those children (including locked ones) fixed on the page.
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
        new Map([...groupByShape].filter(([id, groupId]) => id !== groupId && isQueryView(shapesById.get(id)!)))
      );
    },
    { ignoreShapeLock: true }
  );
  editor.markHistoryStoppingPoint("layout-kavla-nodes-complete");
}
