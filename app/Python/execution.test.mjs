import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";

// The SDK's browser WASM loader uses fetch; provide file URL support in Node.
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith("file:")) return new Response(await readFile(new URL(url)), { headers: { "Content-Type": "application/wasm" } });
  return nativeFetch(url, options);
};
const sdk = await import("@polyglot-sql/sdk");
const stubs = {
  tldraw: 'let next = 0; export const createShapeId = () => `shape:created-${++next}`;',
  connections: `export const connectShapes = () => {};
    export function setShapeUpstreamConnections(editor, id, ids) {
      const shape = editor.getShape(id); editor.updateShape({id, type: shape.type, props: {upstreamShapeIds: ids}});
      for (const parent of ids) { const shape = editor.getShape(parent); editor.updateShape({id: parent, type: shape.type, props: {downstreamShapeIds: [...new Set([...(shape.props.downstreamShapeIds || []), id])]}}); }
    }`,
  restore: 'export const clearRestoredRemoteQueryMetadata = () => {};',
};
const bundle = await rolldown({ input: fileURLToPath(new URL("./execution.ts", import.meta.url)), plugins: [{
  name: "execution-test-platform",
  resolveId(source) {
    if (source === "tldraw") return "test:tldraw";
    if (source.endsWith("/shapeConnections")) return "test:connections";
    if (source.endsWith("/restoreRemoteQueryView")) return "test:restore";
    if (source === "@polyglot-sql/sdk") return { id: import.meta.resolve(source), external: true };
  },
  load(id) { if (id.startsWith("test:")) return stubs[id.slice(5)]; },
}] });
const { output } = await bundle.generate({ format: "esm" });
await bundle.close();
const { runComputeGraph, cancelComputeRun } = await import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString("base64")}`);

function shape(id, type, text, extra = {}) {
  return { id: `shape:${id}`, type, x: 0, y: 0, props: { name: id, text, w: 400, h: 300, showTable: false,
    isDirty: true, stale: false, isRunning: false, upstreamShapeIds: [], downstreamShapeIds: [], ...extra } };
}
function editorFor(shapes) {
  const records = new Map(shapes.map(s => [s.id, s]));
  return { getCurrentPageShapes: () => [...records.values()], getShape: id => records.get(id),
    updateShape(update) { const old = records.get(update.id); if (old) records.set(update.id, { ...old, props: { ...old.props, ...update.props } }); },
    updateShapes(updates) { updates.forEach(update => this.updateShape(update)); },
    createShape(value) { records.set(value.id, value); },
  };
}
function transport(options = {}) {
  const runs = [];
  const api = {
    async runRemoteQuery(request) { runs.push(["sql", request]); return { rowCount: 15005, schema: [{ name: "x", type: "BIGINT" }], sampleRows: [] }; },
    async getQueryResultPage() { return { rows: [] }; },
    cancelRemoteQuery(id) { runs.push(["cancel", id]); },
  };
  globalThis.fetch = async (url, init) => {
    const request = init.body ? JSON.parse(init.body) : null;
    if (url === "/api/session/python") return Response.json({ config: { version: "3.13", requirements: [] } });
    if (url.endsWith("/analyze")) return Response.json({ dependencies: request.names.filter(name => new RegExp(`\\b${name}\\b`).test(request.code) && name !== "result") });
    if (url.endsWith("/run")) {
      runs.push(["python", request]);
      if (options.onPython) return options.onPython(request, init);
      return Response.json({ rowCount: 15005, schema: [{ name: "x", type: "BIGINT" }] });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  return { api, runs };
}

test("SQL analysis includes quoted names and nested queries, excludes CTE names and comments", () => {
  const analysis = sdk.analyzeQuery('WITH python_2 AS (SELECT * FROM "python_1") SELECT * FROM python_2 -- JOIN missing', "duckdb");
  assert.deepEqual(analysis.analysis.baseTables.map(table => table.table), ["python_1"]);
});

test("runs offscreen SQL → Python → SQL in order with result bindings", async () => {
  const editor = editorFor([shape("query_1", "sql-text-area", "SELECT 1 AS x"), shape("python_1", "python-text-area", "result = query_1.copy()"), shape("query_2", "sql-text-area", 'SELECT * FROM "python_1"')]);
  const { api, runs } = transport();
  await runComputeGraph(editor, "shape:query_2", api);
  assert.deepEqual(runs.map(([kind, request]) => [kind, request.shapeId]), [["sql", "shape:query_1"], ["python", "shape:python_1"], ["sql", "shape:query_2"]]);
  assert.deepEqual(runs[1][1].inputs, { query_1: "shape:query_1" });
  assert.deepEqual(runs[2][1].resultBindings, { python_1: "shape:python_1" });
  assert.equal(editor.getShape("shape:query_2").props.stale, false);
});

test("cycles fail before execution", async () => {
  const editor = editorFor([shape("python_1", "python-text-area", "result = query_1"), shape("query_1", "sql-text-area", "SELECT * FROM python_1")]);
  const { api, runs } = transport();
  await assert.rejects(runComputeGraph(editor, "shape:query_1", api), /cycle/);
  assert.deepEqual(runs, []);
});

test("failed Python stops descendants and retains previous metadata", async () => {
  const oldStats = { executionTime: 12, rowCount: 7, runnerName: "CLI" };
  const editor = editorFor([shape("python_1", "python-text-area", "result = 42", { lastRunStats: oldStats }), shape("query_1", "sql-text-area", "SELECT * FROM python_1")]);
  const { api, runs } = transport({ onPython: () => Response.json({ error: "result must be a DataFrame", line: 1 }) });
  await assert.rejects(runComputeGraph(editor, "shape:query_1", api), /DataFrame/);
  assert.equal(runs.length, 1);
  assert.deepEqual(editor.getShape("shape:python_1").props.lastRunStats, oldStats);
  assert.equal(editor.getShape("shape:python_1").props.stale, true);
});

test("edits during a run remain dirty and stop downstream SQL", async () => {
  const editor = editorFor([shape("python_1", "python-text-area", "result = 1"), shape("query_1", "sql-text-area", "SELECT * FROM python_1")]);
  const { api, runs } = transport({ onPython: () => {
    editor.updateShape({ id: "shape:python_1", props: { text: "result = 2", isDirty: true } });
    return Response.json({ rowCount: 1, schema: [] });
  } });
  await assert.rejects(runComputeGraph(editor, "shape:query_1", api), /changed while running/);
  assert.equal(editor.getShape("shape:python_1").props.isDirty, true);
  assert.equal(runs.length, 1);
});

test("Stop cancels active Python and clears running state", async () => {
  const editor = editorFor([shape("python_1", "python-text-area", "result = 1")]);
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const { api } = transport({ onPython: (_, init) => new Promise((_, reject) => {
    started(); init.signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
  }) });
  const run = runComputeGraph(editor, "shape:python_1", api);
  await ready;
  cancelComputeRun(editor, api);
  await assert.rejects(run, /cancelled/);
  assert.equal(editor.getShape("shape:python_1").props.isRunning, false);
});

test("a clean Python dependency is reused until it becomes stale", async () => {
  const editor = editorFor([shape("python_1", "python-text-area", "result = 1"), shape("query_1", "sql-text-area", "SELECT * FROM python_1")]);
  const { api, runs } = transport();
  await runComputeGraph(editor, "shape:query_1", api);
  await runComputeGraph(editor, "shape:query_1", api);
  assert.deepEqual(runs.map(([kind]) => kind), ["python", "sql", "sql"]);
  editor.updateShape({ id: "shape:python_1", props: { stale: true } });
  await runComputeGraph(editor, "shape:query_1", api);
  assert.deepEqual(runs.map(([kind]) => kind), ["python", "sql", "sql", "python", "sql"]);
});

test("unsupported browser sources are rejected before running Python", async () => {
  const editor = editorFor([shape("file_1", "data-source", ""), shape("python_1", "python-text-area", "result = file_1")]);
  const { api, runs } = transport();
  await assert.rejects(runComputeGraph(editor, "shape:python_1", api), /backend DuckDB/);
  assert.equal(runs.length, 0);
});

test("an upstream edit during Python execution prevents a clean downstream result", async () => {
  const editor = editorFor([shape("query_1", "sql-text-area", "SELECT 1 AS x"), shape("python_1", "python-text-area", "result = query_1"), shape("query_2", "sql-text-area", "SELECT * FROM python_1")]);
  const { api, runs } = transport({ onPython: () => {
    editor.updateShape({ id: "shape:query_1", props: { text: "SELECT 2 AS x" } });
    return Response.json({ rowCount: 1, schema: [] });
  } });
  await assert.rejects(runComputeGraph(editor, "shape:query_2", api), /Upstream .* changed/);
  assert.equal(runs.length, 2);
  assert.equal(editor.getShape("shape:python_1").props.stale, true);
});
