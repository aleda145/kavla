// Headless integration fixture. Not included in the application's build.
import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import { Tldraw, createShapeId, getSnapshot, loadSnapshot, type Editor, type TLDrawShape } from "tldraw";
import "tldraw/tldraw.css";
import { getAssetUrlsByImport } from "@tldraw/assets/imports.vite";
import { tableFromIPC } from "apache-arrow";
import { ChartUtil } from "../ChartUtil";
import { SQLTextAreaUtil } from "../../SQLTextArea/SQLTextAreaUtil";
import { SQLResultTableUtil } from "../../SQLResultArea/SQLResultAreaUtil";
import { KavlaArrowBindingUtil } from "../../client/KavlaArrowShapeUtil";
import { LocalServerContext } from "../../client/localServer/LocalServerProvider";
import type { LocalServerContextType } from "../../client/localServer/types";
import { VisualizationContext } from "./VisualizationProvider";
import { createVisualizationSession } from "./coordinator";
import { chartGeometry } from "./geometry";
import { planScatter, statisticsSQL } from "./planner";
import { selectionSQL, type Axis, type ScatterSelection } from "./selection";
import type { ChartShape } from "../chart-shape-types";
import type { SQLTextAreaShape } from "../../SQLTextArea/sql-text-area-types";
import { connectShapes } from "../../util/shapeConnections";
import { executeSQLShape } from "../../SQLTextArea/executeSQLShape";
import { buildChartOption } from "../chartOptions";
import * as echarts from "echarts";
import * as duckdb from "@duckdb/duckdb-wasm";
import wasmURL from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import workerURL from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import { reuseBrowserConnection } from "./browser-connector";

const transport: { sql: string; bytes: number; httpMs: number; timing: string | null }[] = [];
async function request(body: unknown, signal?: AbortSignal) {
  const response = await fetch("/query", { method: "POST", body: JSON.stringify(body), signal });
  if (!response.ok) throw new Error(await response.text());
  return response;
}
const session = createVisualizationSession(async (sql, signal) => {
  const start = performance.now();
  const response = await request({ sql }, signal);
  const bytes = new Uint8Array(await response.arrayBuffer());
  transport.push({
    sql,
    bytes: bytes.byteLength,
    httpMs: performance.now() - start,
    timing: response.headers.get("Server-Timing"),
  });
  return bytes;
});
const unsupported = () => {
  throw new Error("This operation is outside the headless fixture.");
};
const data: LocalServerContextType = {
  runRemoteQuery: async (payload) => {
    const result = await (await request({ ...payload, operation: "create" })).json();
    return { ...result, sampleRows: [] };
  },
  getQueryResultPage: async (payload) => {
    const response = await request({ ...payload, signal: undefined, operation: "page" }, payload.signal);
    return {
      rows: tableFromIPC(await response.arrayBuffer())
        .toArray()
        .map((row) => row.toJSON()),
    };
  },
  cancelRemoteQuery: () => {},
  updateSourceName: () => {},
  deleteShapes: () => {},
  getSourceTables: unsupported,
  getSourceSchema: unsupported,
  getSourceStats: unsupported,
  prepareSourceDownload: unsupported,
  prepareQueryResultDownload: unsupported,
  sendAgentPrompt: unsupported,
  sendAgentToolResult: unsupported,
  cancelAgent: unsupported,
  retryAgent: unsupported,
};
const sourceSQL = (n: number) => `SELECT i AS id, (i % 1000)::DOUBLE / 1000 AS x,
  (floor(i / 1000) % 100)::DOUBLE / 100 AS y FROM range(${n}) AS t(i)`;
const sourceId = createShapeId("viz-source"),
  chartId = createShapeId("viz-chart");
let editor: Editor;
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
async function waitUntil(check: () => boolean, label: string) {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > 30000) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function click(text: string) {
  const button = [...document.querySelectorAll("button")].find(
    (b) => b.textContent === text || b.getAttribute("aria-label") === text
  );
  if (!button || button.disabled) throw new Error(`Button unavailable: ${text}`);
  button.click();
}
async function setup(n = 1000000) {
  await waitUntil(() => Boolean(editor), "editor");
  editor.deleteShapes([...editor.getCurrentPageShapeIds()]);
  session.coordinator.clear();
  const sql = sourceSQL(n);
  editor.createShape<SQLTextAreaShape>({
    id: sourceId,
    type: "sql-text-area",
    x: -1000,
    y: 0,
    props: { name: "observations", text: sql, isDirty: true, showTable: false },
  });
  const output = await executeSQLShape(editor, data, sourceId, sql, new AbortController().signal, {
    createMissingKnobs: false,
  });
  if (!output.success) throw new Error(output.error!);
  editor.createShape<ChartShape>({
    id: chartId,
    type: "chart-shape",
    x: 60,
    y: 60,
    props: { sourceShapeId: sourceId, x: "x", y: "y", w: 600, h: 400 },
    meta: { nativeVisualization: true },
  });
  connectShapes(editor, sourceId, chartId);
  editor.setCamera({ x: 0, y: 0, z: 1 });
  await waitUntil(() => document.body.textContent?.includes(`${n.toLocaleString()} rows`) ?? false, "native plot");
  await frame();
}
function lassoPagePoints() {
  const shape = editor.getShape<ChartShape>(chartId)!;
  const geometry = chartGeometry(
    shape.props.w - 56,
    shape.props.h - 142 - (shape.props.color ? 24 : 0) - (shape.meta.nativeSelection ? 34 : 0),
    { field: "x", type: "linear", domain: [0, 0.999] },
    { field: "y", type: "linear", domain: [0, 0.99] }
  );
  // Select raw triangle x>=0,y>=0,x+y<=0.5, entirely within the plot.
  return [
    { x: 0, y: 0 },
    { x: 0.5, y: 0 },
    { x: 0, y: 0.5 },
    { x: 0, y: 0 },
  ].map((p) => {
    const local = geometry.project(p);
    return editor.getShapePageTransform(shape).applyToPoint({ x: local.x + 4, y: local.y + 46 });
  });
}
async function programmaticLasso() {
  editor.setCurrentTool("draw");
  const points = lassoPagePoints();
  const id = createShapeId();
  editor.createShape<TLDrawShape>({
    id,
    type: "draw",
    x: 0,
    y: 0,
    props: { segments: [{ type: "free", points }], isComplete: false, isClosed: true },
  });
  editor.updateShape<TLDrawShape>({ id, type: "draw", props: { isComplete: true } });
  await waitUntil(() => document.body.textContent?.includes("128,010 selected") ?? false, "exact count");
  click("Explore");
  await waitUntil(
    () =>
      editor
        .getCurrentPageShapes()
        .some(
          (s) =>
            s.type === "sql-text-area" &&
            s.id !== sourceId &&
            (s as SQLTextAreaShape).props.lastRunStats?.rowCount === 128010
        ),
    "executed SQL branch"
  );
  const branch = editor
    .getCurrentPageShapes()
    .find((s) => s.type === "sql-text-area" && s.id !== sourceId) as SQLTextAreaShape;
  const tail = await data.getQueryResultPage({ shapeId: branch.id, offset: 128000, limit: 10 });
  if (tail.rows.length !== 10) throw new Error("Selected result was truncated.");
  if (editor.getShape(id) || !editor.getShape(chartId) || !editor.getShape(sourceId))
    throw new Error("The chart must own the outline and preserve the source shapes.");
  return {
    rowCount: branch.props.lastRunStats?.rowCount,
    linked: branch.props.upstreamShapeIds?.includes(sourceId),
    tailRows: tail.rows.length,
    sqlLength: branch.props.text.length,
  };
}
async function transformsAndPersistence() {
  const initial = editor.getShape<ChartShape>(chartId)!;
  const selection = JSON.parse(initial.meta.nativeSelection as string) as ScatterSelection;
  const results = [];
  const queriesBefore = transport.length;
  editor.updateShape({ id: chartId, type: "chart-shape", x: 120, y: 100 });
  editor.setCamera({ x: -50, y: -30, z: 0.7 });
  await frame();
  results.push({ action: "move/pan/zoom", addedQueries: transport.length - queriesBefore });
  for (const [w, h] of [
    [300, 800],
    [1000, 260],
    [600, 400],
  ]) {
    const start = performance.now();
    editor.updateShape({ id: chartId, type: "chart-shape", props: { w, h } });
    await frame();
    const after = editor.getShape<ChartShape>(chartId)!;
    if (after.meta.nativeSelection !== initial.meta.nativeSelection) throw new Error("Resize changed selection.");
    results.push({ action: `${w}x${h}`, frameMs: performance.now() - start });
  }
  const before = JSON.stringify(getSnapshot(editor.store));
  loadSnapshot(editor.store, JSON.parse(before));
  const after = editor.getShape<ChartShape>(chartId)!;
  if (after.meta.nativeSelection !== initial.meta.nativeSelection)
    throw new Error("Selection did not survive snapshot roundtrip.");
  const result = await session.coordinator.query(
    `SELECT count(*) AS n FROM (${selectionSQL(selection.sourceSQL, selection)})`,
    { cache: false }
  );
  if (Number(result.toArray()[0].n) !== 128010) throw new Error("Restored selection changed.");
  return results;
}

async function benchmark() {
  const axis: Axis = { field: "x", type: "linear", domain: [0, 1] };
  const rows = [];
  for (const n of [1000, 10000, 100000, 1000000, 10000000]) {
    const sql = sourceSQL(n);
    session.coordinator.clear();
    let t = performance.now();
    await session.coordinator.query(statisticsSQL(sql, "x", "y"));
    const statsMs = performance.now() - t;
    t = performance.now();
    const plan = planScatter(sql, axis, { ...axis, field: "y" }, n, 502, 204);
    const planMs = performance.now() - t;
    t = performance.now();
    const table = await session.coordinator.query(plan.sql);
    const plotMs = performance.now() - t;
    const plotTransport = transport.at(-1)!;
    t = performance.now();
    await session.coordinator.query(plan.sql);
    const cacheMs = performance.now() - t;
    const polygon = [
      { x: 0, y: 0 },
      { x: 0.5, y: 0 },
      { x: 0, y: 0.5 },
    ];
    t = performance.now();
    const count = await session.coordinator.query(
      `SELECT count(*) AS n FROM (${selectionSQL(sql, { x: axis, y: { ...axis, field: "y" }, polygon })})`,
      { cache: false }
    );
    const lassoMs = performance.now() - t;
    const lassoTransport = transport.at(-1)!;
    // Current ECharts path takes the first 10,000 rows. Compare with its real
    // option builder and renderer, without claiming equivalent data coverage.
    t = performance.now();
    const response = await request({ sql: `SELECT * FROM (${sql}) LIMIT 10000` });
    const raw = await response.arrayBuffer();
    const legacyFetchMs = performance.now() - t;
    t = performance.now();
    const legacy = tableFromIPC(raw)
      .toArray()
      .map((row) => row.toJSON());
    const legacyDecodeMs = performance.now() - t;
    const node = document.createElement("div");
    node.style.cssText = "position:absolute;left:0;top:0;width:510px;height:248px";
    document.body.append(node);
    const legacyRenderer = legacy.length < 1000 ? "svg" : "canvas";
    const chart = echarts.init(node, null, { renderer: legacyRenderer });
    t = performance.now();
    chart.setOption(
      buildChartOption({
        chartHeight: 400,
        chartType: "scatter",
        x: "x",
        y: "y",
        color: null,
        columnTypes: { id: "BIGINT", x: "DOUBLE", y: "DOUBLE" },
        data: legacy,
        isStacked: false,
        resolvedYAxisScale: "auto",
      })
    );
    const legacySetOptionMs = performance.now() - t;
    await frame();
    const legacyFrameMs = performance.now() - t;
    chart.dispose();
    node.remove();
    rows.push({
      n,
      mode: plan.mode,
      marks: table.numRows,
      statsMs,
      planMs,
      plotMs,
      cacheMs,
      arrowBytes: plotTransport.bytes,
      plotTiming: plotTransport.timing,
      httpMs: plotTransport.httpMs,
      decodeAndScheduleMs: plotMs - plotTransport.httpMs,
      lassoMs,
      lassoTiming: lassoTransport.timing,
      selected: Number(count.toArray()[0].n),
      legacyRows: legacy.length,
      legacyBytes: raw.byteLength,
      legacyFetchMs,
      legacyDecodeMs,
      legacyRenderer,
      legacySetOptionMs,
      legacyFrameMs,
    });
  }
  return rows;
}

async function wasmBenchmark() {
  // Isolated test database only: production does not create a WASM instance.
  const worker = new Worker(workerURL);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(wasmURL);
  const connection = await db.connect();
  const wasmSession = reuseBrowserConnection(connection);
  const results = [];
  try {
    for (const n of [1000, 10000, 100000, 1000000, 10000000]) {
      const axis: Axis = { field: "x", type: "linear", domain: [0, 1] };
      const plan = planScatter(sourceSQL(n), axis, { ...axis, field: "y" }, n, 502, 204);
      let start = performance.now();
      const table = await wasmSession.coordinator.query(plan.sql);
      const plotMs = performance.now() - start;
      start = performance.now();
      const result = await wasmSession.coordinator.query(
        `SELECT count(*) AS n FROM (${selectionSQL(sourceSQL(n), {
          x: axis,
          y: { ...axis, field: "y" },
          polygon: [
            { x: 0, y: 0 },
            { x: 0.5, y: 0 },
            { x: 0, y: 0.5 },
          ],
        })})`
      );
      results.push({
        n,
        marks: table.numRows,
        plotMs,
        selectionMs: performance.now() - start,
        count: Number(result.toArray()[0].n),
      });
    }
    return {
      results,
      version: await db.getVersion(),
      memory: (performance as Performance & { memory?: unknown }).memory,
    };
  } finally {
    wasmSession.dispose();
    await connection.close();
    await db.terminate();
    worker.terminate();
  }
}

Object.assign(window, {
  vizTest: {
    setup,
    programmaticLasso,
    transformsAndPersistence,
    benchmark,
    wasmBenchmark,
    lassoScreenPoints: () => lassoPagePoints().map((p) => editor.pageToScreen(p)),
    startDraw: () => editor.setCurrentTool("draw"),
    state: () => ({
      text: document.body.textContent,
      shapes: editor.getCurrentPageShapes(),
      requests: transport.length,
    }),
    renderer: async (renderer: string) => {
      const chart = editor.getShape(chartId)!;
      const start = performance.now();
      editor.updateShape({ id: chartId, type: "chart-shape", meta: { ...chart.meta, nativeRenderer: renderer } });
      await frame();
      return performance.now() - start;
    },
  },
});
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocalServerContext.Provider value={data}>
      <VisualizationContext.Provider value={session}>
        <div style={{ position: "fixed", inset: 0 }}>
          <Tldraw
            shapeUtils={[ChartUtil, SQLTextAreaUtil, SQLResultTableUtil]}
            bindingUtils={[KavlaArrowBindingUtil]}
            assetUrls={getAssetUrlsByImport()}
            onMount={(value) => {
              editor = value;
            }}
          />
        </div>
      </VisualizationContext.Provider>
    </LocalServerContext.Provider>
  </StrictMode>
);
