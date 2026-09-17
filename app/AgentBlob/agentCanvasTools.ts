import type { AgentToolEnvironment } from "../client/localServer/agentRuns";
import { executeSQLShape } from "../SQLTextArea/executeSQLShape";
import { getOrderedDependenciesForSQL } from "../SQLTextArea/sqlDependencies";
import type { LensShape } from "../Lens/lens-shape-types";
import type { SummaryShape, SummaryArtifact, SummarySection } from "../Summary/summary-shape-types";
import { runLensTool } from "./agentLensTools";
import { computeAgentProfiles, getAgentDataPreview, resolveAgentDataShape } from "./agentDataTools";
import {
  createShapeId,
  toRichText,
  renderPlaintextFromRichText,
  type TLNoteShape,
  type Editor,
  type TLShape,
  type TLShapeId,
} from "tldraw";
import { format } from "sql-formatter";
import type { ChartShape } from "../Chart/chart-shape-types";
import type { DataSourceShape } from "../DataSource/data-source-types";
import { type SQLShapeRunResult } from "../SQLTextArea/sqlShapeRun";
import type { SQLTextAreaShape } from "../SQLTextArea/sql-text-area-types";
import { getAutoExpandedSQLShapeSize } from "../SQLTextArea/sqlShapeSize";
import type { SQLResultTableShape } from "../SQLResultArea/sql-result-table-types";
import { connectShapes } from "../util/shapeConnections";
import { getUniqueName } from "../util/getUniqueName";
import { getAgentContextShapeIds } from "./agent-chat-store";
import { getAgentLayout, getAgentPlacement, reflowAgentQuery, trackAgentQueryLayout } from "./agentLayout";

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

const getDataShapeOrThrow = resolveAgentDataShape;


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

function sanitizeValue(value: unknown, depth = 0, key = ""): unknown {
  if (depth > 10) return "[nested value omitted]";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    const limit = key === "sql" || key === "code" ? 24000 : 1000;
    return value.length > limit ? `${value.slice(0, limit)}…` : value;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return "[binary value omitted]";
  if (Array.isArray(value)) {
    const limit = key === "sampleRows" || key === "topValues" ? 5 : key === "shapes" ? 50 : 100;
    return value.slice(0, limit).map((item) => sanitizeValue(item, depth + 1, key));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 80)
        .map(([key, item]) => [key, sanitizeValue(item, depth + 1, key)])
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

function describeShape(editor: Editor, shape: TLShape): Record<string, unknown> | null {
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
      linkedTableId: query.props.linkedTableId,
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
      yAxisScale: chart.props.yAxisScale,
      isStacked: chart.props.isStacked,
      limit: chart.props.limit,
    };
  }
  if (shape.type === "sql-result-table") {
    const result = shape as SQLResultTableShape;
    return { id: result.id, type: "result", sourceShapeId: result.props.sourceShapeId };
  }
  if (shape.type === "note") {
    return { id: shape.id, type: "note", text: renderPlaintextFromRichText(editor, (shape as TLNoteShape).props.richText) };
  }
  if (shape.type === "lens-shape") {
    const lens = shape as LensShape;
    return { id: lens.id, type: "lens", name: lens.props.name, sourceShapeId: lens.props.sourceShapeId, prompt: lens.props.prompt, dataSql: lens.props.dataSql, description: lens.props.description, error: lens.props.error, generationStatus: lens.props.generationStatus };
  }
  if (shape.type === "summary-shape") {
    const summary = shape as SummaryShape;
    return { id: summary.id, type: "summary", name: summary.props.name, question: summary.props.question, answer: summary.props.answer, sections: summary.props.sections, artifacts: summary.props.artifacts };
  }
  return null;
}

export function buildPromptCanvasContext(editor: Editor, explicitShapeIds?: string[]): Record<string, unknown> {
  const selectedShapeIds = editor.getSelectedShapeIds().map(String);
  const contextShapeIds = explicitShapeIds?.length
    ? explicitShapeIds.map((id) => id as TLShapeId)
    : getAgentContextShapeIds(editor);
  const includedIds = new Set(contextShapeIds);
  for (const id of includedIds) {
    if (includedIds.size >= 50) break;
    const shape = editor.getShape(id);
    if (!shape) continue;
    if ("sourceShapeId" in shape.props && typeof shape.props.sourceShapeId === "string") includedIds.add(shape.props.sourceShapeId as TLShapeId);
    if (shape.type === "sql-text-area") {
      for (const dep of getOrderedDependenciesForSQL(editor, (shape as SQLTextAreaShape).props.text).orderedDependencies) includedIds.add(dep.id);
    }
  }
  return {
    selectedShapeIds,
    shapes: Array.from(includedIds)
      .map((id) => editor.getShape(id))
      .filter((shape): shape is TLShape => Boolean(shape))
      .map((shape) => describeShape(editor, shape))
      .filter(Boolean),
    canvasShapeCount: editor.getCurrentPageShapes().length,
    profilePolicy: "Profiles are deterministic metadata recorded on existing shapes. Analytical SQL uses visible query nodes.",
  };
}

async function createQuery(editor: Editor, args: ToolArguments, env: AgentToolEnvironment, onActivityShape?: (shapeId: string) => void): Promise<ToolResult> {
  const source = getDataShapeOrThrow(editor, requiredString(args, "sourceShapeId"));
  const sql = formatAgentSQL(requiredString(args, "sql"));
  const desiredName = optionalString(args, "name") ?? "agent_query";
  const shapeId = createShapeId();
  const layout = getAgentLayout(args, source.id, "right");
  const placement = getAgentPlacement(editor, layout, source.id, getAutoExpandedSQLShapeSize(sql));
  editor.createShape<SQLTextAreaShape>({
    id: shapeId,
    type: "sql-text-area",
    x: placement.x,
    y: placement.y,
    props: {
      text: sql,
      name: getUniqueName(editor, desiredName),
      showTable: true,
    },
  });
  trackAgentQueryLayout(editor, shapeId, layout);
  connectShapes(editor, source.id, shapeId);
  onActivityShape?.(shapeId);
  env.signal.throwIfAborted();
  let result: SQLShapeRunResult;
  try {
    result = await executeSQLShape(editor, env.data, shapeId, sql, env.signal);
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
  reflowAgentQuery(editor, shapeId);
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

async function runExistingQuery(editor: Editor, args: ToolArguments, env: AgentToolEnvironment): Promise<ToolResult> {
  const shapeId = requiredString(args, "shapeId") as TLShapeId;
  const shape = getShapeOrThrow(editor, shapeId);
  if (shape.type !== "sql-text-area") throw new Error(`Shape ${shapeId} is not a visible SQL query.`);
  const query = shape as SQLTextAreaShape;
  const sql = query.props.text.trim();
  let result: SQLShapeRunResult;
  try {
    result = await executeSQLShape(editor, env.data, query.id, sql, env.signal);
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

async function updateQuery(editor: Editor, args: ToolArguments, env: AgentToolEnvironment): Promise<ToolResult> {
  const shapeId = requiredString(args, "shapeId") as TLShapeId;
  const shape = getShapeOrThrow(editor, shapeId);
  if (shape.type !== "sql-text-area") throw new Error(`Shape ${shapeId} is not a SQL query.`);
  const query = shape as SQLTextAreaShape;
  const sql = formatAgentSQL(requiredString(args, "sql"));
  if (!query.meta.agentQueryLayout) {
    trackAgentQueryLayout(editor, query.id, getAgentLayout(args, query.props.upstreamShapeIds?.[0] as TLShapeId | undefined ?? null, "right"));
  }
  const desiredName = optionalString(args, "name");
  editor.updateShape<SQLTextAreaShape>({
    id: query.id,
    type: "sql-text-area",
    props: {
      text: sql,
      isDirty: true,
      error: null,
      ...(desiredName ? { name: getUniqueName(editor, desiredName, query.id) } : {}),
    },
  });
  reflowAgentQuery(editor, query.id);
  env.signal.throwIfAborted();
  let result: SQLShapeRunResult;
  try {
    result = await executeSQLShape(editor, env.data, query.id, sql, env.signal);
  } catch (error) {
    env.signal.throwIfAborted();
    if (editor.getShape(query.id)) editor.updateShape<SQLTextAreaShape>({ id: query.id, type: "sql-text-area", props: { error: error instanceof Error ? error.message : String(error), isDirty: true } });
    return boundedResult({
      ok: false,
      shapeId: query.id,
      name: editor.getShape<SQLTextAreaShape>(query.id)?.props.name,
      error: error instanceof Error ? error.message : String(error),
      guidance: "The attempted SQL remains visible. Change the SQL pattern materially before running it again.",
    });
  }
  env.signal.throwIfAborted();
  reflowAgentQuery(editor, query.id);
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

async function createChart(editor: Editor, args: ToolArguments, env: AgentToolEnvironment): Promise<ToolResult> {
  const sourceShapeId = requiredString(args, "sourceShapeId") as TLShapeId;
  const selected = getShapeOrThrow(editor, sourceShapeId);
  const resolvedId = "sourceShapeId" in selected.props && typeof selected.props.sourceShapeId === "string" ? selected.props.sourceShapeId : sourceShapeId;
  const source = selected.type === "sql-text-area" ? selected : getShapeOrThrow(editor, resolvedId);
  if (source.type !== "sql-text-area") throw new Error("Charts must use a SQL query shape as their source.");
  const query = source as SQLTextAreaShape;
  if (query.props.isDirty || query.props.stale || query.props.error || !query.props.lastRunStats) {
    const result = await executeSQLShape(editor, env.data, query.id, query.props.text.trim(), env.signal);
    if (!result.success) throw new Error(result.error || "The source query failed.");
  }
  env.signal.throwIfAborted();
  const chartType = requiredString(args, "chartType");
  if (!["scatter", "line", "bar", "area"].includes(chartType)) throw new Error(`Unsupported chart type ${chartType}.`);
  const x = requiredString(args, "x");
  const y = requiredString(args, "y");
  const color = optionalString(args, "color");
  const columns = new Set((editor.getShape<SQLTextAreaShape>(query.id)?.props.outputSchema ?? []).map((column) => column.name));
  for (const column of [x, y, color].filter((value): value is string => Boolean(value))) {
    if (!columns.has(column)) throw new Error(`Column ${column} is not in query ${query.props.name}.`);
  }
  const shapeId = createShapeId();
  const w = typeof args.w === "number" ? Math.max(400, Math.min(1200, args.w)) : 600;
  const h = typeof args.h === "number" ? Math.max(300, Math.min(1000, args.h)) : 400;
  if (args.isStacked === true && (!color || !["bar", "area"].includes(chartType))) throw new Error("Stacking requires a bar or area chart with a grouping column.");
  const chartAnchorId = query.props.linkedTableId && editor.getShape(query.props.linkedTableId as TLShapeId)
    ? query.props.linkedTableId as TLShapeId
    : query.id;
  const placement = getAgentPlacement(
    editor,
    getAgentLayout(args, chartAnchorId, "right"),
    chartAnchorId,
    { w, h },
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
      yAxisScale: ["default", "auto", "zero"].includes(String(args.yAxisScale)) ? String(args.yAxisScale) : "default",
      isStacked: typeof args.isStacked === "boolean" ? args.isStacked : Boolean(color && ["bar", "area"].includes(chartType)),
      limit: typeof args.limit === "number" ? Math.max(1, Math.min(10000, Math.round(args.limit))) : null,
      w,
      h,
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

async function updateChart(editor: Editor, args: ToolArguments, env: AgentToolEnvironment): Promise<ToolResult> {
  const shape = getShapeOrThrow(editor, requiredString(args, "shapeId"));
  if (shape.type !== "chart-shape") throw new Error("The selected shape is not a chart.");
  const chart = shape as ChartShape;
  const changes: Partial<ChartShape["props"]> = {};
  for (const key of ["chartType", "x", "y", "yAxisScale"] as const) {
    if (key in args) changes[key] = requiredString(args, key);
  }
  if ("name" in args) changes.name = getUniqueName(editor, requiredString(args, "name"), chart.id);
  if ("color" in args) changes.color = args.color === null ? null : requiredString(args, "color");
  if ("isStacked" in args) {
    if (typeof args.isStacked !== "boolean") throw new Error("isStacked must be a boolean.");
    changes.isStacked = args.isStacked;
  }
  if ("limit" in args) {
    if (args.limit !== null && (typeof args.limit !== "number" || !Number.isSafeInteger(args.limit) || args.limit < 1)) {
      throw new Error("limit must be a positive integer or null.");
    }
    changes.limit = args.limit as number | null;
  }
  if (!Object.keys(changes).length) throw new Error("Provide at least one chart setting to change.");
  const next = { ...chart.props, ...changes };
  if (!next.chartType || !["scatter", "line", "bar", "area"].includes(next.chartType)) {
    throw new Error(`Unsupported chart type ${next.chartType}.`);
  }
  if (!["default", "auto", "zero"].includes(next.yAxisScale)) throw new Error("Unsupported y-axis scale.");
  const source = next.sourceShapeId ? editor.getShape(next.sourceShapeId as TLShapeId) : null;
  if (!source || source.type !== "sql-text-area") throw new Error("The chart is not connected to an existing SQL query.");
  if (!next.x || !next.y) throw new Error("Choose both x and y columns for the chart.");
  const query = source as SQLTextAreaShape;
  if (query.props.isDirty || query.props.stale || query.props.error || !query.props.lastRunStats) {
    const result = await executeSQLShape(editor, env.data, query.id, query.props.text.trim(), env.signal);
    if (!result.success) throw new Error(result.error || "The source query failed.");
  }
  env.signal.throwIfAborted();
  const schema = editor.getShape<SQLTextAreaShape>(query.id)?.props.outputSchema;
  if (!schema?.length) throw new Error("Run the chart's source query before editing its settings.");
  const columns = new Set(schema.map((column) => column.name));
  for (const column of [next.x, next.y, next.color]) {
    if (column && !columns.has(column)) throw new Error(`Column ${column} is not in the chart's source query.`);
  }
  if (!["bar", "area"].includes(next.chartType) || !next.color) {
    if (args.isStacked === true) throw new Error("Stacking needs a bar or area chart with a grouping column.");
    changes.isStacked = false;
  }
  editor.updateShape<ChartShape>({ id: chart.id, type: "chart-shape", props: changes });
  return { ok: true, shapeId: chart.id, sourceShapeId: next.sourceShapeId, chart: { ...next, ...changes } };
}

function updateNote(editor: Editor, args: ToolArguments): ToolResult {
  const shape = getShapeOrThrow(editor, requiredString(args, "shapeId"));
  if (shape.type !== "note") throw new Error("The selected shape is not a note.");
  const text = requiredString(args, "text");
  if (text.length > 4000) throw new Error("Keep note text within 4,000 characters.");
  editor.updateShape<TLNoteShape>({ id: shape.id, type: "note", props: { richText: toRichText(text) } });
  return { ok: true, shapeId: shape.id, text };
}

export async function executeAgentCanvasTool(
  editor: Editor,
  tool: string,
  args: ToolArguments,
  onActivityShape: ((shapeId: string) => void) | undefined,
  env: AgentToolEnvironment,
): Promise<ToolResult> {
  env.signal.throwIfAborted();
  switch (tool) {
    case "get_canvas_context": {
      const requestedIds = Array.isArray(args.shapeIds)
        ? args.shapeIds.filter((id): id is string => typeof id === "string")
        : editor.getCurrentPageShapes()
            .filter((shape) => ["data-source", "sql-text-area", "sql-result-table", "chart-shape", "note", "lens-shape", "summary-shape"].includes(shape.type))
            .slice(0, 50)
            .map((shape) => String(shape.id));
      return hydratePromptCanvasContext(editor, env.data, requestedIds);
    }
    case "create_query":
      return createQuery(editor, args, env, onActivityShape);
    case "run_query":
      return runExistingQuery(editor, args, env);
    case "update_query":
      return updateQuery(editor, args, env);
    case "create_chart":
      return createChart(editor, args, env);
    case "create_note":
      return createNote(editor, args);
    case "update_chart":
      return updateChart(editor, args, env);
    case "update_note":
      return updateNote(editor, args);
    case "compute_column_profiles":
      return boundedResult(await computeAgentProfiles(editor, args, env));
    case "create_lens":
    case "update_lens":
      return runLensTool(editor, args, env, tool === "update_lens", onActivityShape);
    case "create_summary":
      return createSummary(editor, args, env);
    default:
      throw new Error(`Unknown Kavla Agent tool ${tool}.`);
  }
}

function createSummary(editor: Editor, args: ToolArguments, env: AgentToolEnvironment): ToolResult {
  const question = requiredString(args, "question");
  const answer = requiredString(args, "answer");
  if (!Array.isArray(args.sections) || !Array.isArray(args.artifacts)) throw new Error("Summary sections and evidence artifacts are required.");
  const sections: SummarySection[] = args.sections.slice(0, 8).map((raw) => {
    const section = raw as ToolArguments;
    return { title: requiredString(section, "title"), body: requiredString(section, "body") };
  });
  const artifacts: SummaryArtifact[] = args.artifacts.slice(0, 6).map((raw) => {
    const artifact = raw as ToolArguments;
    const shape = getShapeOrThrow(editor, requiredString(artifact, "shapeId"));
    return { shapeId: shape.id, title: requiredString(artifact, "title"), note: requiredString(artifact, "note"), kind: shape.type };
  });
  const id = createShapeId();
  const anchor = artifacts[0]?.shapeId as TLShapeId | undefined;
  const placement = getAgentPlacement(editor, getAgentLayout(args, anchor || null, "summary"), anchor || null, { w: 560, h: 680 });
  editor.createShape<SummaryShape>({ id, type: "summary-shape", x: placement.x, y: placement.y, props: { name: optionalString(args, "name") || "Summary", question, answer, sections, artifacts, sourceJobId: env.runId } });
  return { ok: true, shapeId: id, question, answer, evidenceShapeIds: artifacts.map((artifact) => artifact.shapeId) };
}

export async function hydratePromptCanvasContext(editor: Editor, data: AgentToolEnvironment["data"], shapeIds?: string[]) {
  const context = buildPromptCanvasContext(editor, shapeIds);
  const shapes = context.shapes as Record<string, unknown>[];
  await Promise.all(shapes.filter((shape) => shape.type === "query").slice(0, 6).map(async (shape) => {
    if (shape.isDirty || shape.stale || shape.error) return;
    try { shape.sampleRows = await getAgentDataPreview(editor, String(shape.id), data, 5); }
    catch (error) { shape.previewUnavailable = error instanceof Error ? error.message : String(error); }
  }));
  return boundedResult(context);
}
