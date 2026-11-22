// Runs WASM in Node, never launches a browser. It is NOT a browser CPU/memory
// benchmark. The isolated database belongs only to this experiment.
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as duckdb from "@duckdb/duckdb-wasm/blocking";
import { createVisualizationSession } from "./coordinator.ts";
import { planScatter } from "./planner.ts";
import { selectionSQL } from "./selection.ts";

const require = createRequire(import.meta.url);
const db = await duckdb.createDuckDB({
  mvp: { mainModule: require.resolve("@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm"), mainWorker: "" },
}, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
await db.instantiate();
db.open({ query: { castBigIntToDouble: true } });
const connection = db.connect();
await connection.query("CREATE TABLE reuse_probe AS SELECT 42 AS n");
const session = createVisualizationSession(async (sql, signal) => {
  signal.throwIfAborted();
  return connection.useUnsafe((bindings, handle) => bindings.runQuery(handle, sql));
});
const rows = [];
try {
  const probe = await session.coordinator.query("SELECT n FROM reuse_probe");
  if (probe.toArray()[0].n !== 42) throw new Error("The existing WASM connection was not reused.");
  for (const n of [1000, 10000, 100000, 1000000, 10000000]) {
    const source = `SELECT i AS id, (i % 1000)::DOUBLE/1000 AS x,
      (floor(i/1000) % 100)::DOUBLE/100 AS y FROM range(${n}) AS t(i)`;
    const x = { field: "x", type: "linear", domain: [0, 1] };
    const y = { ...x, field: "y" };
    const plan = planScatter(source, x, y, n, 502, 204);
    const cpu = process.cpuUsage();
    let t = performance.now();
    const plot = await session.coordinator.query(plan.sql);
    const plotMs = performance.now() - t;
    t = performance.now();
    const selected = await session.coordinator.query(`SELECT count(*) AS n FROM (${selectionSQL(source, {
      x, y, polygon: [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0, y: 0.5 }],
    })})`, { cache: false });
    rows.push({ n, plotMs, selectionMs: performance.now() - t, marks: plot.numRows,
      selected: Number(selected.toArray()[0].n), wasmHeapBytes: db.mod.HEAPU8.byteLength,
      cpuMicroseconds: process.cpuUsage(cpu), processMemory: process.memoryUsage() });
  }
  const output = { method: "DuckDB-WASM MVP in Node; existing connection reused; no browser, no worker, no rendering.",
    duckdbVersion: db.getVersion(), rows };
  await writeFile(resolve(process.cwd(), "../docs/visualization/wasm-node-results.json"), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
} finally { session.dispose(); connection.close(); }
