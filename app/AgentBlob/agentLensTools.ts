import { isLensRuntimeUnavailable } from "../Lens/lens-errors";
import { createShapeId, type Editor, type TLShapeId } from "tldraw";
import type { LensShape } from "../Lens/lens-shape-types";
import type { SQLTextAreaShape } from "../SQLTextArea/sql-text-area-types";
import type { AgentToolEnvironment } from "../client/localServer/agentRuns";
import { executeSQLShape } from "../SQLTextArea/executeSQLShape";
import { prepareGeneratedChartWidgetRuntime, validateGeneratedChartWidget } from "../Chart/GeneratedChartWidget";
import { getUniqueName } from "../util/getUniqueName";
import { connectShapes } from "../util/shapeConnections";
import { getAgentLayout, getAgentPlacement } from "./agentLayout";
import { getAgentDataPreview, resolveAgentDataShape } from "./agentDataTools";

export async function runLensTool(editor: Editor, args: Record<string, unknown>, env: AgentToolEnvironment, editing: boolean, onActivityShape?: (id: string) => void): Promise<Record<string, unknown>> {
  const existing = editing ? editor.getShape<LensShape>(String(args.shapeId) as TLShapeId) : undefined;
  if (editing && existing?.type !== "lens-shape") throw new Error("Choose an existing Lens to edit.");
  const visualPrompt = (typeof args.visualPrompt === "string" ? args.visualPrompt.trim() : "") || (editing ? env.prompt.trim() : "");
  if (!visualPrompt) throw new Error("A visualPrompt is required.");
  const source = resolveAgentDataShape(editor, existing?.props.sourceShapeId || String(args.sourceShapeId || ""));
  if (source.type !== "sql-text-area") throw new Error("Create a visible analytical query before creating a Lens.");
  if (source.props.isDirty || source.props.stale || source.props.error || !source.props.lastRunStats) {
    const result = await executeSQLShape(editor, env.data, source.id, source.props.text.trim(), env.signal);
    if (!result.success) throw new Error(result.error || "The Lens source query failed.");
  }
  env.signal.throwIfAborted();
  const query = editor.getShape<SQLTextAreaShape>(source.id)!;
  const id = existing?.id || createShapeId();
  if (!existing) {
    const w = typeof args.w === "number" ? Math.max(360, Math.min(1600, args.w)) : 720;
    const h = typeof args.h === "number" ? Math.max(240, Math.min(1200, args.h)) : 480;
    const placement = getAgentPlacement(editor, getAgentLayout(args, query.id, "below"), query.id, { w, h });
    editor.createShape<LensShape>({ id, type: "lens-shape", x: placement.x, y: placement.y, props: { name: getUniqueName(editor, typeof args.name === "string" ? args.name : "Lens"), sourceShapeId: query.id, prompt: visualPrompt, w, h, generationStatus: "generating", jobId: env.runId } });
    connectShapes(editor, query.id, id);
  } else {
    editor.updateShape<LensShape>({ id, type: "lens-shape", props: { generationStatus: "generating", jobId: env.runId, error: null } });
  }
  onActivityShape?.(id);
  let lastError = existing?.props.error || "";
  let attemptCode = existing?.props.code || "";
  let attemptDataSql = existing?.props.dataSql || null;
  let attempts = 0;
  try {
    await prepareGeneratedChartWidgetRuntime();
    env.signal.throwIfAborted();
    const data = await getAgentDataPreview(editor, query.id, env.data, null, env.signal);
    const schema = query.props.outputSchema || [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      env.signal.throwIfAborted();
      const current = editor.getShape<LensShape>(id);
      if (!current) throw new Error("The Lens was removed.");
      const codeBeforeGeneration = current.props.code;
      const sqlBeforeGeneration = current.props.dataSql;
      // Transport, authentication, and generation endpoint failures cannot be repaired by rewriting JSX.
      const previousCode = attemptCode;
      const previousDataSql = attemptDataSql;
      attempts = attempt;
      const generated = await env.generateLens(visualPrompt, {
          targetShapeId: id, userRequest: env.prompt,
          sourceName: query.props.name, schema, rowCount: query.props.lastRunStats?.rowCount, sampleRows: data.slice(0, 5),
          isSampled: false, sourceSql: query.props.text, currentCode: attemptCode, currentDataSql: attemptDataSql,
          dataIntent: args.dataIntent, currentTitle: current.props.title, currentDescription: current.props.description, width: current.props.w - 48, height: current.props.h - 46, attempt, latestError: lastError,
        });
      env.signal.throwIfAborted();
      attemptCode = generated.code || "";
      attemptDataSql = generated.dataSql?.trim() || null;
      if (attempt > 1 && attemptCode === previousCode && attemptDataSql === previousDataSql) throw new Error("The Lens generator repeated the same failed code. Stopped without another attempt.");
      try {
        await validateGeneratedChartWidget({ isSampled: false, code: attemptCode, dataSql: attemptDataSql, rows: data, columns: schema.map((column) => column.name), columnTypes: Object.fromEntries(schema.map((column) => [column.name, column.type])), sourceName: query.props.name, width: current.props.w - 48, height: current.props.h - 46 });
        env.signal.throwIfAborted();
        const latest = editor.getShape<LensShape>(id);
        if (!latest) throw new Error("The Lens was removed.");
        if (latest.props.code !== codeBeforeGeneration || latest.props.dataSql !== sqlBeforeGeneration) throw new Error("The Lens was edited during generation; the Agent kept your edit.");
        const latestQuery = editor.getShape<SQLTextAreaShape>(query.id);
        if (!latestQuery || latestQuery.props.text !== query.props.text || latestQuery.props.isDirty || latestQuery.props.stale) throw new Error("The source query changed during generation.");
        editor.updateShape<LensShape>({ id, type: "lens-shape", props: { code: attemptCode, dataSql: attemptDataSql, title: generated.title || latest.props.name, description: generated.description || null, prompt: visualPrompt, generationStatus: "ready", error: null, generatedAt: Date.now() } });
        return { ok: true, shapeId: id, sourceShapeId: query.id, title: generated.title, attempts: attempt, isSampled: false };
      } catch (error) {
        env.signal.throwIfAborted();
        lastError = error instanceof Error ? error.message : String(error);
        if (isLensRuntimeUnavailable(error)) throw error;
        if (lastError.includes("kept your edit") || lastError.includes("was removed") || lastError.includes("source query changed")) throw error;
        if (attempt < 2 && editor.getShape(id)) editor.updateShape<LensShape>({ id, type: "lens-shape", props: { generationStatus: "repairing", error: lastError } });
      }
    }
    throw new Error(lastError || "Lens generation failed after two attempts.");
  } catch (error) {
    const message = env.signal.aborted ? "Lens generation stopped." : error instanceof Error ? error.message : String(error);
    const latest = editor.getShape<LensShape>(id);
    if (latest) editor.updateShape<LensShape>({ id, type: "lens-shape", props: {
      generationStatus: "error", error: message,
      // Keep a failed first draft available in the Code/SQL tabs without replacing a user's existing Lens.
      ...(!latest.props.code && attemptCode ? { code: attemptCode, dataSql: attemptDataSql } : {}),
    } });
    env.signal.throwIfAborted();
    return { ok: false, shapeId: id, error: message, attempts, retryable: false, stopRun: true, guidance: "Stop this run. Do not generate another Lens or call update_lens again. The error and available code remain on the canvas; retry only when the user explicitly asks." };
  }
}
