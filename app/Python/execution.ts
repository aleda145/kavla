import { createShapeId, type Editor, type TLShape, type TLShapeId } from "tldraw";
import type { DataSourceShape } from "../DataSource/data-source-types";
import { getRemoteSourceMetadata } from "../DataSource/remote-source-metadata";
import { extractTableNames } from "../util/parseSql";
import { quoteDottedIdentifier } from "../src/duckdb/sql";
import { connectShapes, setShapeUpstreamConnections } from "../util/shapeConnections";
import { MissingQueryResultError } from "../client/localServer/types";
import type { LocalServerContextType } from "../client/localServer/types";
import { clearRestoredRemoteQueryMetadata } from "../SQLTextArea/restoreRemoteQueryView";
import { pythonRequest, type ComputeShape, type PythonAnalysis, type PythonConfig, type PythonResult } from "./types";

type DataShape = ComputeShape | DataSourceShape;
const executions = new WeakMap<Editor, { controller: AbortController; activeId?: string }>();
const loaded = new WeakMap<Editor, Map<string, string>>();
export const isComputeShape = (shape: TLShape | undefined): shape is ComputeShape =>
  shape?.type === "sql-text-area" || shape?.type === "python-text-area";
const isDataShape = (shape: TLShape): shape is DataShape => isComputeShape(shape) || shape.type === "data-source";

export function invalidatePythonResults(editor: Editor) {
  executions.get(editor)?.controller.abort();
  loaded.delete(editor);
  editor.updateShapes(editor.getCurrentPageShapes().filter(isComputeShape).map(shape => ({
    id: shape.id, type: shape.type, props: { stale: true },
  })));
}

export function markDescendantsStale(editor: Editor, id: TLShapeId) {
  const visited = new Set<string>();
  const visit = (sourceId: TLShapeId) => {
    if (visited.has(sourceId)) return;
    visited.add(sourceId);
    const shape = editor.getShape(sourceId);
    if (!shape || !("downstreamShapeIds" in shape.props)) return;
    for (const downstreamId of (shape as DataShape).props.downstreamShapeIds ?? []) {
      const child = editor.getShape(downstreamId as TLShapeId);
      if (isComputeShape(child)) {
        if (!child.props.stale) editor.updateShape({ id: child.id, type: child.type, props: { stale: true } });
        visit(child.id);
      }
    }
  };
  visit(id);
}

export function cancelComputeRun(editor: Editor, api: LocalServerContextType) {
  const execution = executions.get(editor);
  execution?.controller.abort();
  if (execution?.activeId) api.cancelRemoteQuery(execution.activeId);
}

export function ensureComputeTable(editor: Editor, shape: ComputeShape) {
  if (!shape.props.showTable) return;
  if (shape.props.linkedTableId && editor.getShape(shape.props.linkedTableId as TLShapeId)) return;
  const id = createShapeId();
  editor.createShape({ id, type: "sql-result-table", x: shape.x, y: shape.y + shape.props.h + 60,
    props: { sourceShapeId: shape.id, w: 400, h: 300 } });
  editor.updateShape({ id: shape.id, type: shape.type, props: { linkedTableId: id } });
  connectShapes(editor, shape.id, id);
}

// Executes outside shape components, including nodes culled from the viewport.
export async function runComputeGraph(editor: Editor, targetId: TLShapeId, api: LocalServerContextType) {
  if (executions.has(editor)) throw new Error("Another Python workflow is running. Stop it or wait for it to finish.");
  const execution = { controller: new AbortController(), activeId: undefined as string | undefined };
  executions.set(editor, execution);
  const signal = execution.controller.signal;
  const snapshot = editor.getCurrentPageShapes().filter(isDataShape);
  const byName = new Map(snapshot.map(shape => [shape.props.name.toLowerCase(), shape]));
  const byId = new Map(snapshot.map(shape => [shape.id, shape]));
  const dependencies = new Map<string, DataShape[]>();
  const ordered: DataShape[] = [];
  const visiting = new Set<string>(), visited = new Set<string>();
  const cache = loaded.get(editor) ?? new Map<string, string>();
  loaded.set(editor, cache);
  let environment: PythonConfig | null = null;
  const completed = new Set<string>();
  const check = () => { if (signal.aborted) throw new DOMException("Run cancelled", "AbortError"); };
  const update = (shape: ComputeShape, props: Partial<ComputeShape["props"]>) => {
    if (editor.getShape(shape.id)) editor.updateShape({ id: shape.id, type: shape.type, props });
  };
  const root = byId.get(targetId);
  if (!root || !isComputeShape(root)) { executions.delete(editor); throw new Error("The shape no longer exists."); }
  update(root, { isRunning: true, error: null, queryStartTime: Date.now(), runnerName: "CLI" });
  try {
    const walk = async (shape: DataShape): Promise<void> => {
      check();
      if (visiting.has(shape.id)) throw new Error(`Dependency cycle at "${shape.props.name}".`);
      if (visited.has(shape.id)) return;
      visiting.add(shape.id);
      let names: string[] = [];
      if (shape.type === "python-text-area") {
        const analysis = await pythonRequest<PythonAnalysis>("/analyze", {
          code: shape.props.text, names: snapshot.map(s => s.props.name), prepare: true,
        }, signal);
        if (analysis.error) {
          if (editor.getShape(shape.id)) editor.updateShape({ id: shape.id, type: shape.type, props: { error: analysis.error, errorLine: analysis.line ?? null, stale: true } });
          throw new Error(`In ${shape.props.name}${analysis.line ? `, line ${analysis.line}` : ""}: ${analysis.error}`);
        }
        names = analysis.dependencies;
      } else if (shape.type === "sql-text-area") {
        names = extractTableNames(shape.props.text);
      } else {
        const remote = getRemoteSourceMetadata(shape);
        if (!remote || remote.sourceType !== "duckdb") throw new Error(`Python workflows currently require backend DuckDB sources. "${shape.props.name}" is not one.`);
      }
      const upstream = [...new Set(names.map(name => byName.get(name.toLowerCase())).filter((s): s is DataShape => !!s))];
      dependencies.set(shape.id, upstream);
      for (const dependency of upstream) await walk(dependency);
      if (isComputeShape(shape)) setShapeUpstreamConnections(editor, shape.id, upstream.map(s => s.id));
      visiting.delete(shape.id); visited.add(shape.id); ordered.push(shape);
    };
    await walk(root);
    environment = (await pythonRequest<{ config: PythonConfig }>("", undefined, signal, "GET")).config;
    for (const shape of ordered) {
      check();
      for (const input of ordered.filter(s => completed.has(s.id) && isComputeShape(s))) {
        const current = editor.getShape<ComputeShape>(input.id);
        if (!current || (isComputeShape(input) && (current.props.text !== input.props.text || current.props.name !== input.props.name))) {
          throw new Error(`Upstream "${input.props.name}" changed during execution. Run again.`);
        }
      }
      execution.activeId = shape.id;
      const upstream = dependencies.get(shape.id) ?? [];
      const signature = JSON.stringify([isComputeShape(shape) ? [shape.props.text, shape.props.name] : shape.props, environment, upstream.map(s => cache.get(s.id))]);
      if (shape.type === "python-text-area" && shape.id !== targetId && !shape.props.stale && !shape.props.isDirty && cache.get(shape.id) === signature) {
        try { await api.getQueryResultPage({ shapeId: shape.id, offset: 0, limit: 1 }); completed.add(shape.id); continue; } catch (error) { if (!(error instanceof MissingQueryResultError)) throw error; }
      }
      const start = Date.now();
      if (isComputeShape(shape)) update(shape, { isRunning: true, error: null, queryStartTime: start, runnerName: "CLI" });
      let result: { rowCount: number; schema: { name: string; type: string }[] };
      try {
        const inputs = Object.fromEntries(upstream.map(s => [s.props.name, s.id]));
        if (shape.type === "python-text-area") {
          const response = await pythonRequest<PythonResult>("/run", { shapeId: shape.id, name: shape.props.name, code: shape.props.text, inputs }, signal);
          editor.updateShape({ id: shape.id, type: shape.type, props: { output: response.output ?? "", errorLine: response.line ?? null } });
          if (response.error) throw new Error(response.traceback || response.error);
          result = response;
        } else {
          const sql = shape.type === "data-source"
            ? `SELECT * FROM ${quoteDottedIdentifier(getRemoteSourceMetadata(shape)!.remoteTableRef)}`
            : shape.props.text;
          const abort = () => api.cancelRemoteQuery(shape.id);
          signal.addEventListener("abort", abort, { once: true });
          try {
            result = await api.runRemoteQuery({ sql, shapeId: shape.id, queryName: shape.props.name, resultBindings: inputs });
          } finally { signal.removeEventListener("abort", abort); }
        }
        check();
        for (const input of ordered.filter(s => completed.has(s.id) && isComputeShape(s))) {
          const currentInput = editor.getShape<ComputeShape>(input.id);
          if (!currentInput || (isComputeShape(input) && (currentInput.props.text !== input.props.text || currentInput.props.name !== input.props.name))) {
            throw new Error(`Upstream "${input.props.name}" changed during execution. Run again.`);
          }
        }
        cache.set(shape.id, shape.type === "python-text-area" ? signature : `${Date.now()}:${Math.random()}`);
        if (isComputeShape(shape)) {
          clearRestoredRemoteQueryMetadata(shape.id);
          const current = editor.getShape<ComputeShape>(shape.id);
          if (!current) throw new Error(`Shape "${shape.props.name}" was deleted during execution.`);
          const changed = current.props.text !== shape.props.text || current.props.name !== shape.props.name;
          update(shape, { isRunning: false, queryStartTime: null, runnerName: null, error: null,
            isDirty: changed, stale: changed, outputSchema: result.schema, columnStats: null,
            lastRunStats: { executionTime: Date.now() - start, rowCount: result.rowCount, runnerName: "CLI" } });
          markDescendantsStale(editor, shape.id);
          ensureComputeTable(editor, current);
          completed.add(shape.id);
          if (changed) throw new Error(`"${shape.props.name}" changed while running. Run again to use the new code.`);
        }
      } catch (error) {
        if (isComputeShape(shape)) update(shape, { stale: true, error: signal.aborted ? null : String(error instanceof Error ? error.message : error) });
        throw error;
      } finally {
        if (isComputeShape(shape)) update(shape, { isRunning: false, queryStartTime: null, runnerName: null });
      }
    }
  } catch (error) {
    update(root, { stale: true, error: signal.aborted ? null : error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    update(root, { isRunning: false, queryStartTime: null, runnerName: null });
    executions.delete(editor);
  }
}
