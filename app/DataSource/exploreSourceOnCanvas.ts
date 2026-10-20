import { createShapeId, type Editor, type TLArrowBinding, type TLArrowShape, type TLShapeId } from "tldraw";
import type { SourceExploration } from "../client/localServer/types";
import { getUniqueName } from "../util/getUniqueName";
import { toValidSqlName } from "../util/sql";
import type { DataSourceShape } from "./data-source-types";
import { calculateDataSourceHeight, calculateDataSourceWidth } from "./ingestLocalDataSourceFile";

type Table = SourceExploration["tables"][number];
type PositionedTable = { table: Table; x: number; y: number; w: number; h: number };

function layoutTables({ tables, relationships }: SourceExploration): PositionedTable[] {
  const byRef = new Map(tables.map((table) => [table.tableRef, table]));
  const neighbors = new Map(tables.map((table) => [table.tableRef, new Set<string>()]));
  const references = new Map<string, number>();
  for (const relationship of relationships) {
    if (relationship.fromTable === relationship.toTable) continue;
    neighbors.get(relationship.fromTable)?.add(relationship.toTable);
    neighbors.get(relationship.toTable)?.add(relationship.fromTable);
    references.set(relationship.toTable, (references.get(relationship.toTable) ?? 0) + 1);
  }
  const sorted = [...tables].sort(
    (a, b) =>
      (references.get(b.tableRef) ?? 0) - (references.get(a.tableRef) ?? 0) || a.tableRef.localeCompare(b.tableRef)
  );
  const visited = new Set<string>();
  const groups: Table[][][] = [];
  const isolated = new Map<string, Table[]>();

  // Start each connected component at its most referenced table, then put
  // neighboring tables in successive columns. Cycles are visited only once.
  for (const table of sorted) {
    if (visited.has(table.tableRef)) continue;
    visited.add(table.tableRef);
    if (!neighbors.get(table.tableRef)?.size) {
      const group = isolated.get(table.schema) ?? [];
      group.push(table);
      isolated.set(table.schema, group);
      continue;
    }
    const layers: Table[][] = [[table]];
    for (let level = 0; level < layers.length; level++) {
      const next: Table[] = [];
      for (const current of layers[level]) {
        for (const neighbor of neighbors.get(current.tableRef) ?? []) {
          if (visited.has(neighbor)) continue;
          const neighborTable = byRef.get(neighbor);
          if (!neighborTable) throw new Error(`Missing related table: ${neighbor}`);
          visited.add(neighbor);
          next.push(neighborTable);
        }
      }
      if (next.length) layers.push(next);
    }
    groups.push(layers);
  }
  // Tables without foreign keys still sit together by schema.
  for (const group of isolated.values()) groups.push([group]);

  const positioned: PositionedTable[] = [];
  const targetWidth = Math.max(2400, Math.sqrt(tables.length) * 800);
  let groupX = 0;
  let groupY = 0;
  let rowHeight = 0;
  for (const layers of groups) {
    const local: PositionedTable[] = [];
    let x = 0;
    let height = 0;
    const maxRows = Math.max(2, Math.ceil(Math.sqrt(layers.flat().length)));
    for (const layer of layers) {
      // Wrap large fan-outs so one hub cannot produce a very tall diagram.
      for (let offset = 0; offset < layer.length; offset += maxRows) {
        let y = 0;
        let width = 0;
        for (const table of layer.slice(offset, offset + maxRows)) {
          const w = calculateDataSourceWidth(table.columns, `${table.schema}.${table.name}`);
          const h = calculateDataSourceHeight(table.columns, null);
          local.push({ table, x, y, w, h });
          width = Math.max(width, w);
          y += h + 160;
        }
        height = Math.max(height, y - 160);
        x += width + 320;
      }
    }
    const width = x - 320;
    if (groupX > 0 && groupX + width > targetWidth) {
      groupX = 0;
      groupY += rowHeight + 320;
      rowHeight = 0;
    }
    positioned.push(...local.map((item) => ({ ...item, x: item.x + groupX, y: item.y + groupY })));
    groupX += width + 400;
    rowHeight = Math.max(rowHeight, height);
  }
  return positioned;
}

export function exploreSourceOnCanvas(
  editor: Editor,
  pickerId: TLShapeId,
  sourceName: string,
  exploration: SourceExploration
) {
  const picker = editor.getShape<DataSourceShape>(pickerId);
  if (!picker || editor.getIsReadonly()) return;
  if (!exploration.tables.length) throw new Error("No tables found to explore.");
  const reusePicker = !picker.props.filename;
  const requiredShapes = exploration.tables.length + exploration.relationships.length - (reusePicker ? 1 : 0);
  if (editor.getCurrentPageShapeIds().size + requiredShapes > editor.options.maxShapesPerPage) {
    throw new Error("There are too many tables and relationships for this page. Try exploring on an empty page.");
  }
  const positions = layoutTables(exploration);
  const pickerBounds = editor.getShapePageBounds(picker)!;
  let originX = pickerBounds.x;
  for (const shape of editor.getCurrentPageShapes()) {
    if (reusePicker && shape.id === pickerId) continue;
    const bounds = editor.getShapePageBounds(shape);
    if (bounds) originX = Math.max(originX, bounds.maxX + 320);
  }
  const tableIds = new Map<string, TLShapeId>();
  const arrowIds: TLShapeId[] = [];
  const mark = editor.markHistoryStoppingPoint("explore-source");
  try {
    editor.run(() => {
      for (const [index, item] of positions.entries()) {
        const id = reusePicker && index === 0 ? pickerId : createShapeId();
        const props: Partial<DataSourceShape["props"]> = {
          name: getUniqueName(editor, toValidSqlName(item.table.name), id),
          filename: `${item.table.schema}.${item.table.name}`,
          sourceName,
          sourceType: "postgres",
          remoteTableRef: item.table.tableRef,
          metadata: item.table.columns,
          rowCount: null,
          error: null,
          isRunning: false,
          w: item.w,
          h: item.h,
        };
        const shape = {
          id,
          type: "data-source" as const,
          parentId: editor.getCurrentPageId(),
          rotation: 0,
          x: originX + item.x,
          y: pickerBounds.y + item.y,
          props,
        };
        if (id === pickerId) editor.updateShape<DataSourceShape>(shape);
        else editor.createShape<DataSourceShape>(shape);
        tableIds.set(item.table.tableRef, id);
      }

      const pairCounts = new Map<string, number>();
      const pairOffsets = new Map<string, number>();
      for (const relationship of exploration.relationships) {
        const key = JSON.stringify([relationship.fromTable, relationship.toTable].sort());
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
      for (const relationship of exploration.relationships) {
        const fromId = tableIds.get(relationship.fromTable);
        const toId = tableIds.get(relationship.toTable);
        if (!fromId || !toId) throw new Error(`Missing table for foreign key ${relationship.name}`);
        const from = editor.getShapePageBounds(fromId)!;
        const to = editor.getShapePageBounds(toId)!;
        const self = fromId === toId;
        const key = JSON.stringify([relationship.fromTable, relationship.toTable].sort());
        const offset = pairOffsets.get(key) ?? 0;
        pairOffsets.set(key, offset + 1);
        const fraction = (offset + 1) / ((pairCounts.get(key) ?? 1) + 1);
        const horizontal = Math.abs(from.center.x - to.center.x) >= Math.abs(from.center.y - to.center.y);
        const start = self
          ? { x: 1, y: 0.25 }
          : horizontal
            ? { x: from.center.x < to.center.x ? 1 : 0, y: fraction }
            : { x: fraction, y: from.center.y < to.center.y ? 1 : 0 };
        const end = self
          ? { x: 1, y: 0.75 }
          : horizontal
            ? { x: 1 - start.x, y: fraction }
            : { x: fraction, y: 1 - start.y };
        const id = createShapeId();
        // These are ordinary bound arrows, independent of SQL lineage.
        editor.createShape<TLArrowShape>({
          id,
          type: "arrow",
          parentId: editor.getCurrentPageId(),
          x: from.x,
          y: from.y,
          props: {
            kind: self ? "arc" : "elbow",
            size: "s",
            font: "mono",
            bend: self ? -180 - offset * 60 : 0,
            arrowheadStart: "none",
            arrowheadEnd: "arrow",
            start: { x: start.x * from.w, y: start.y * from.h },
            end: { x: to.x - from.x + end.x * to.w, y: to.y - from.y + end.y * to.h },
            text: `${relationship.columns.join(", ")} → ${relationship.referencedColumns.join(", ")}`,
          },
        });
        editor.createBindings<TLArrowBinding>([
          {
            type: "arrow",
            fromId: id,
            toId: fromId,
            props: { terminal: "start", normalizedAnchor: start, isExact: true, isPrecise: true },
          },
          {
            type: "arrow",
            fromId: id,
            toId,
            props: { terminal: "end", normalizedAnchor: end, isExact: true, isPrecise: true },
          },
        ]);
        arrowIds.push(id);
      }
      editor.sendToBack(arrowIds);
      editor.select(...tableIds.values(), ...arrowIds);
    });
  } catch (error) {
    editor.bailToMark(mark);
    throw error;
  }
  editor.zoomToSelection({ animation: { duration: 250 } });
}
