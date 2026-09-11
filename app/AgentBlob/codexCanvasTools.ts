import {
  createShapeId,
  toRichText,
  type TLNoteShape,
  type Editor,
  type TLShape,
  type TLShapeId,
} from "tldraw";
import { format } from "sql-formatter";
import type { ChartShape } from "../Chart/chart-shape-types";
import type { DataSourceShape } from "../DataSource/data-source-types";
import { requestSQLShapeRun, type SQLShapeRunResult } from "../SQLTextArea/sqlShapeRun";
import type { SQLTextAreaShape } from "../SQLTextArea/sql-text-area-types";
import type { SQLResultTableShape } from "../SQLResultArea/sql-result-table-types";
import { connectShapes } from "../util/shapeConnections";
import { getUniqueName } from "../util/getUniqueName";
import { getAgentContextShapeIds } from "./codex-agent-store";
import { getAgentLayout, getAgentPlacement } from "./agentLayout";

const SAMPLE_ROW_LIMIT = 20;
const MAX_TEXT_LENGTH = 500;
const MAX_RESULT_JSON_LENGTH = 64 * 1024;

type ToolArguments = Record<string, unknown>;
type ToolResult = Record<string, unknown>;

function requiredString(args: ToolArguments, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required.`);
  }
  return value.trim();
}

function optionalString(args: ToolArguments, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getShapeOrThrow(editor: Editor, shapeId: string): TLShape {
  const shape = editor.getShape(shapeId as TLShapeId);
  if (!shape) throw new Error(`Canvas shape ${shapeId} does not exist.`);
  return shape;
}

function getDataShapeOrThrow(editor: Editor, shapeId: string): DataSourceShape | SQLTextAreaShape {
  const shape = getShapeOrThrow(editor, shapeId);
  if (shape.type === "sql-result-table") {
    const result = shape as SQLResultTableShape;
    const source = result.props.sourceShapeId
      ? editor.getShape(result.props.sourceShapeId as TLShapeId)
      : null;
    if (source?.type === "sql-text-area") return source as SQLTextAreaShape;
    throw new Error(`Result shape ${shapeId} is not connected to a SQL query.`);
  }
  if (shape.type !== "data-source" && shape.type !== "sql-text-area") {
    throw new Error(`Shape ${shapeId} is not a data source or SQL query.`);
  }
  return shape as DataSourceShape | SQLTextAreaShape;
}

function stripSQLForValidation(sql: string): string {
  return sql
    .replace(/--[^\n\r]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, "''")
    .trim();
}

function validateReadOnlySQL(value: string): string {
  const sql = value.trim();
  if (!sql) throw new Error("SQL is required.");
  const normalized = stripSQLForValidation(sql).replace(/;+\s*$/, "");
  if (!/^(select|with)\b/i.test(normalized)) {
    throw new Error("The Kavla Agent can only run SELECT or WITH queries.");
  }
  if (normalized.includes(";")) {
    throw new Error("The Kavla Agent can only run one SQL statement at a time.");
  }
  if (/\b(insert|update|delete|drop|create|alter|copy|attach|detach|install|load|call|pragma|export|import)\b/i.test(normalized)) {
    throw new Error("The Kavla Agent cannot run SQL that changes data, files, or DuckDB configuration.");
  }
  return sql.replace(/;+\s*$/, "");
}

function formatAgentSQL(sql: string): string {
  try {
    return format(sql, {
      language: "duckdb",
      keywordCase: "upper",
      tabWidth: 2,
    });
  } catch {
    return sql;
  }
}

function waitForShapeMount(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
  });
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[nested value omitted]";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    return value.length > MAX_TEXT_LENGTH ? `${value.slice(0, MAX_TEXT_LENGTH)}…` : value;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return "[binary value omitted]";
  if (Array.isArray(value)) return value.slice(0, SAMPLE_ROW_LIMIT).map((item) => sanitizeValue(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 80)
        .map(([key, item]) => [key, sanitizeValue(item, depth + 1)])
    );
  }
  return value;
}

function boundedResult(value: ToolResult): ToolResult {
  const sanitized = sanitizeValue(value) as ToolResult;
  const serialized = JSON.stringify(sanitized);
  if (serialized.length <= MAX_RESULT_JSON_LENGTH) return sanitized;
  return {
    truncated: true,
    message: "The tool result was larger than the 64 KiB agent context limit.",
    preview: serialized.slice(0, MAX_RESULT_JSON_LENGTH),
  };
}

function compactColumnStats(stats: Record<string, unknown> | null | undefined) {
  if (!stats) return null;
  return Object.fromEntries(
    Object.entries(stats).slice(0, 40).map(([column, rawStats]) => {
      if (!rawStats || typeof rawStats !== "object") return [column, rawStats];
      const value = rawStats as Record<string, unknown>;
      return [column, sanitizeValue({
        type: value.type,
        min: value.min,
        max: value.max,
        nullCount: value.nullCount,
        nullPercentage: value.nullPercentage,
        distinctCount: value.distinctCount,
        topValues: Array.isArray(value.topValues) ? value.topValues.slice(0, 5) : undefined,
        error: value.error,
      })];
    })
  );
}

function describeShape(shape: TLShape): Record<string, unknown> | null {
  if (shape.type === "data-source") {
    const source = shape as DataSourceShape;
    return {
      id: source.id,
      type: "source",
      name: source.props.name,
      sourceType: source.props.sourceType,
      fileName: source.props.filename,
      rowCount: source.props.rowCount,
      schema: source.props.metadata,
      columnStats: compactColumnStats(source.props.columnStats),
      error: source.props.error,
    };
  }
  if (shape.type === "sql-text-area") {
    const query = shape as SQLTextAreaShape;
    return {
      id: query.id,
      type: "query",
      name: query.props.name,
      sql: query.props.text,
      rowCount: query.props.lastRunStats?.rowCount ?? null,
      schema: query.props.outputSchema,
      columnStats: compactColumnStats(query.props.columnStats),
      upstreamShapeIds: query.props.upstreamShapeIds,
      error: query.props.error,
      stale: query.props.stale,
      isDirty: query.props.isDirty,
    };
  }
  if (shape.type === "chart-shape") {
    const chart = shape as ChartShape;
    return {
      id: chart.id,
      type: "chart",
      name: chart.props.name,
      sourceShapeId: chart.props.sourceShapeId,
      chartType: chart.props.chartType,
      x: chart.props.x,
      y: chart.props.y,
      color: chart.props.color,
    };
  }
  if (shape.type === "sql-result-table") {
    const result = shape as SQLResultTableShape;
    return { id: result.id, type: "result", sourceShapeId: result.props.sourceShapeId };
  }
  if (shape.type === "note") {
    return { id: shape.id, type: "note", richText: (shape as TLNoteShape).props.richText };
  }
  return null;
}

export function buildPromptCanvasContext(editor: Editor, explicitShapeIds?: string[]): Record<string, unknown> {
  const selectedShapeIds = editor.getSelectedShapeIds().map(String);
  const contextShapeIds = explicitShapeIds?.length
    ? explicitShapeIds.map((id) => id as TLShapeId)
    : getAgentContextShapeIds(editor);
  return {
    selectedShapeIds,
    shapes: contextShapeIds
      .map((id) => editor.getShape(id))
      .filter((shape): shape is TLShape => Boolean(shape))
      .map(describeShape)
      .filter(Boolean),
    canvasShapeCount: editor.getCurrentPageShapes().length,
  };
}

async function createQuery(editor: Editor, args: ToolArguments): Promise<ToolResult> {
  const source = getDataShapeOrThrow(editor, requiredString(args, "sourceShapeId"));
  const sql = formatAgentSQL(validateReadOnlySQL(requiredString(args, "sql")));
  const desiredName = optionalString(args, "name") ?? "agent_query";
  const shapeId = createShapeId();
  const viewport = editor.getViewportPageBounds();
  editor.createShape<SQLTextAreaShape>({
    id: shapeId,
    type: "sql-text-area",
    x: viewport.center.x - 200,
    y: viewport.center.y - 150,
    props: {
      text: sql,
      name: getUniqueName(editor, desiredName),
      showTable: true,
    },
  });
  const createdForPlacement = editor.getShape<SQLTextAreaShape>(shapeId);
  if (!createdForPlacement) throw new Error("The SQL query shape could not be created.");
  const finalPlacement = getAgentPlacement(
    editor,
    getAgentLayout(args, source.id, "right"),
    source.id,
    { w: createdForPlacement.props.w, h: createdForPlacement.props.h },
    shapeId,
  );
  editor.updateShape<SQLTextAreaShape>({
    id: shapeId,
    type: "sql-text-area",
    x: finalPlacement.x,
    y: finalPlacement.y,
  });
  connectShapes(editor, source.id, shapeId);
  await waitForShapeMount();
  let result: SQLShapeRunResult;
  try {
    result = await requestSQLShapeRun(shapeId, sql);
  } catch (error) {
    return boundedResult({
      ok: false,
      shapeId,
      name: editor.getShape<SQLTextAreaShape>(shapeId)?.props.name,
      error: error instanceof Error ? error.message : String(error),
      guidance: "Keep this visible query shape and update it with a materially different, simpler query.",
    });
  }
  if (!result.success) {
    return boundedResult({
      ok: false,
      shapeId,
      name: editor.getShape<SQLTextAreaShape>(shapeId)?.props.name,
      error: result.error || "The SQL query failed.",
      guidance: "Keep this visible query shape and update it with a materially different, simpler query.",
    });
  }
  const createdBeforeMove = editor.getShape<SQLTextAreaShape>(shapeId);
  if (createdBeforeMove?.props.linkedTableId) {
    const resultId = createdBeforeMove.props.linkedTableId as TLShapeId;
    const resultPlacement = getAgentPlacement(
      editor,
      getAgentLayout({ layout: { placement: "below" } }, shapeId, "below"),
      shapeId,
      { w: 400, h: 300 },
      resultId,
    );
    editor.updateShape({
      id: resultId,
      type: "sql-result-table",
      x: resultPlacement.x,
      y: resultPlacement.y,
    });
  }
  const created = editor.getShape<SQLTextAreaShape>(shapeId);
  return boundedResult({
    ok: true,
    shapeId,
    name: created?.props.name,
    linkedTableId: created?.props.linkedTableId,
    rowCount: result.rowCount,
    schema: result.outputSchema,
    sampleRows: result.sampleRows?.slice(0, SAMPLE_ROW_LIMIT) ?? [],
  });
}

async function runExistingQuery(editor: Editor, args: ToolArguments): Promise<ToolResult> {
  const shapeId = requiredString(args, "shapeId") as TLShapeId;
  const shape = getShapeOrThrow(editor, shapeId);
  if (shape.type !== "sql-text-area") throw new Error(`Shape ${shapeId} is not a visible SQL query.`);
  const query = shape as SQLTextAreaShape;
  const sql = validateReadOnlySQL(query.props.text);
  let result: SQLShapeRunResult;
  try {
    result = await requestSQLShapeRun(query.id, sql);
  } catch (error) {
    return boundedResult({
      ok: false,
      shapeId: query.id,
      name: query.props.name,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return boundedResult({
    ok: result.success,
    shapeId: query.id,
    name: query.props.name,
    linkedTableId: editor.getShape<SQLTextAreaShape>(query.id)?.props.linkedTableId,
    error: result.success ? null : result.error || "The visible query failed.",
    rowCount: result.rowCount,
    schema: result.outputSchema,
    sampleRows: result.sampleRows?.slice(0, SAMPLE_ROW_LIMIT) ?? [],
  });
}

async function updateQuery(editor: Editor, args: ToolArguments): Promise<ToolResult> {
  const shapeId = requiredString(args, "shapeId") as TLShapeId;
  const shape = getShapeOrThrow(editor, shapeId);
  if (shape.type !== "sql-text-area") throw new Error(`Shape ${shapeId} is not a SQL query.`);
  const query = shape as SQLTextAreaShape;
  const sql = formatAgentSQL(validateReadOnlySQL(requiredString(args, "sql")));
  const oldX = query.x;
  const oldY = query.y;
  const oldResult = query.props.linkedTableId
    ? editor.getShape(query.props.linkedTableId as TLShapeId)
    : null;
  const oldResultPosition = oldResult ? { x: oldResult.x, y: oldResult.y } : null;
  const desiredName = optionalString(args, "name");
  const viewport = editor.getViewportPageBounds();
  editor.updateShape<SQLTextAreaShape>({
    id: query.id,
    type: "sql-text-area",
    props: {
      text: sql,
      ...(desiredName ? { name: getUniqueName(editor, desiredName, query.id) } : {}),
    },
    x: viewport.center.x - 200,
    y: viewport.center.y - 150,
  });
  await waitForShapeMount();
  let result: SQLShapeRunResult;
  try {
    result = await requestSQLShapeRun(query.id, sql);
  } catch (error) {
    editor.updateShape<SQLTextAreaShape>({ id: query.id, type: "sql-text-area", x: oldX, y: oldY });
    return boundedResult({
      ok: false,
      shapeId: query.id,
      name: editor.getShape<SQLTextAreaShape>(query.id)?.props.name,
      error: error instanceof Error ? error.message : String(error),
      guidance: "The attempted SQL remains visible. Change the SQL pattern materially before running it again.",
    });
  }
  const updatedBeforeMove = editor.getShape<SQLTextAreaShape>(query.id);
  editor.updateShape<SQLTextAreaShape>({ id: query.id, type: "sql-text-area", x: oldX, y: oldY });
  if (updatedBeforeMove?.props.linkedTableId) {
    const resultId = updatedBeforeMove.props.linkedTableId as TLShapeId;
    const queryBounds = editor.getShapePageBounds(query.id);
    const resultBounds = editor.getShapePageBounds(resultId);
    const resultStillClear = queryBounds && resultBounds && (
      resultBounds.minX >= queryBounds.maxX + 28 ||
      resultBounds.maxX <= queryBounds.minX - 28 ||
      resultBounds.minY >= queryBounds.maxY + 28 ||
      resultBounds.maxY <= queryBounds.minY - 28
    );
    const resultPlacement = oldResultPosition && resultStillClear
      ? oldResultPosition
      : getAgentPlacement(
          editor,
          getAgentLayout({ layout: { placement: "below" } }, query.id, "below"),
          query.id,
          { w: resultBounds?.width ?? 400, h: resultBounds?.height ?? 300 },
          resultId,
        );
    editor.updateShape({
      id: resultId,
      type: "sql-result-table",
      x: resultPlacement.x,
      y: resultPlacement.y,
    });
  }
  const updated = editor.getShape<SQLTextAreaShape>(query.id);
  if (!result.success) {
    return boundedResult({
      ok: false,
      shapeId: query.id,
      name: updated?.props.name,
      linkedTableId: updated?.props.linkedTableId,
      error: result.error || "The replacement SQL failed.",
      guidance: "The attempted SQL remains visible. Change the SQL pattern materially before running it again.",
    });
  }
  return boundedResult({
    ok: true,
    shapeId: query.id,
    name: updated?.props.name,
    linkedTableId: updated?.props.linkedTableId,
    rowCount: result.rowCount,
    schema: result.outputSchema,
    sampleRows: result.sampleRows?.slice(0, SAMPLE_ROW_LIMIT) ?? [],
  });
}

function createChart(editor: Editor, args: ToolArguments): ToolResult {
  const sourceShapeId = requiredString(args, "sourceShapeId") as TLShapeId;
  const source = getShapeOrThrow(editor, sourceShapeId);
  if (source.type !== "sql-text-area") throw new Error("Charts must use a SQL query shape as their source.");
  const query = source as SQLTextAreaShape;
  const chartType = requiredString(args, "chartType");
  if (!["scatter", "line", "bar", "area"].includes(chartType)) throw new Error(`Unsupported chart type ${chartType}.`);
  const x = requiredString(args, "x");
  const y = requiredString(args, "y");
  const color = optionalString(args, "color");
  const columns = new Set((query.props.outputSchema ?? []).map((column) => column.name));
  for (const column of [x, y, color].filter((value): value is string => Boolean(value))) {
    if (!columns.has(column)) throw new Error(`Column ${column} is not in query ${query.props.name}.`);
  }
  const shapeId = createShapeId();
  const chartAnchorId = query.props.linkedTableId && editor.getShape(query.props.linkedTableId as TLShapeId)
    ? query.props.linkedTableId as TLShapeId
    : query.id;
  const placement = getAgentPlacement(
    editor,
    getAgentLayout(args, chartAnchorId, "right"),
    chartAnchorId,
    { w: 600, h: 400 },
  );
  editor.createShape<ChartShape>({
    id: shapeId,
    type: "chart-shape",
    x: placement.x,
    y: placement.y,
    props: {
      sourceShapeId: query.id,
      chartType,
      x,
      y,
      color,
      yAxisScale: "default",
      isStacked: false,
      limit: null,
      w: 600,
      h: 400,
      name: getUniqueName(editor, optionalString(args, "name") ?? "chart"),
    },
  });
  connectShapes(editor, query.id, shapeId);
  return { shapeId, sourceShapeId: query.id, chartType, x, y, color };
}

function createNote(editor: Editor, args: ToolArguments): ToolResult {
  const text = requiredString(args, "text");
  const anchorShapeId = optionalString(args, "anchorShapeId");
  const anchor = anchorShapeId ? getShapeOrThrow(editor, anchorShapeId) : null;
  const shapeId = createShapeId();
  const placement = getAgentPlacement(
    editor,
    getAgentLayout(args, anchor?.id ?? null, "summary"),
    anchor?.id ?? null,
    { w: 200, h: 200 },
  );
  editor.createShape<TLNoteShape>({
    id: shapeId,
    type: "note",
    x: placement.x,
    y: placement.y,
    props: { richText: toRichText(text.slice(0, 4000)) },
  });
  return { shapeId, text: text.slice(0, MAX_TEXT_LENGTH) };
}

export async function executeCodexCanvasTool(
  editor: Editor,
  tool: string,
  args: ToolArguments,
): Promise<ToolResult> {
  switch (tool) {
    case "get_canvas_context": {
      const requestedIds = Array.isArray(args.shapeIds)
        ? args.shapeIds.filter((id): id is string => typeof id === "string")
        : editor.getCurrentPageShapes()
            .filter((shape) => ["data-source", "sql-text-area", "sql-result-table", "chart-shape", "note"].includes(shape.type))
            .slice(0, 50)
            .map((shape) => String(shape.id));
      return boundedResult({
        shapes: requestedIds
          .map((id) => editor.getShape(id as TLShapeId))
          .filter((shape): shape is TLShape => Boolean(shape))
          .map(describeShape)
          .filter(Boolean),
      });
    }
    case "create_query":
      return createQuery(editor, args);
    case "run_query":
      return runExistingQuery(editor, args);
    case "update_query":
      return updateQuery(editor, args);
    case "create_chart":
      return createChart(editor, args);
    case "create_note":
      return createNote(editor, args);
    default:
      throw new Error(`Unknown Kavla Agent tool ${tool}.`);
  }
}
