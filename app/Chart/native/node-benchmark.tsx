// No browser or visual inspection. Measures backend + Arrow + SVG generation,
// not DOM layout, Canvas paint, network or tldraw interaction performance.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { tableFromIPC } from "apache-arrow";
import * as echarts from "echarts";
import { createVisualizationSession } from "./coordinator";
import { testBackend } from "./test-backend";
import { statisticsSQL, planScatter } from "./planner";
import { containsPoint, selectionSQL, type Axis } from "./selection";
import { chartGeometry } from "./geometry";
import { ScatterMarks } from "./ScatterMarks";
import { ScatterAxes } from "./ScatterAxes";
import { buildChartOption } from "../chartOptions";

const backend = testBackend();
const session = createVisualizationSession(backend.execute);
const axis: Axis = { field: "x", type: "linear", domain: [0, 1] };
const y = { ...axis, field: "y" };
const polygon = [
  { x: 0, y: 0 },
  { x: 0.5, y: 0 },
  { x: 0, y: 0.5 },
];
const rows = [];
try {
  await session.coordinator.query("SELECT 1 AS warmup");
  for (const n of [1000, 10000, 100000, 1000000, 10000000]) {
    const source = `SELECT i AS id, (i % 1000)::DOUBLE/1000 AS x,
      (floor(i/1000) % 100)::DOUBLE/100 AS y FROM range(${n}) AS t(i)`;
    let t = performance.now();
    await session.coordinator.query(statisticsSQL(source, "x", "y"));
    const statsMs = performance.now() - t;
    t = performance.now();
    const plan = planScatter(source, axis, y, n, 502, 204);
    const planningMs = performance.now() - t;
    t = performance.now();
    const table = await session.coordinator.query(plan.sql);
    const plotRoundtripMs = performance.now() - t;
    const plot = backend.last!;
    t = performance.now();
    await session.coordinator.query(plan.sql);
    const cacheMs = performance.now() - t;
    const marks = table.toArray().map((row) => ({ x: Number(row.x), y: Number(row.y), count: Number(row.count) }));
    const geometry = chartGeometry(592, 268, axis, y);
    t = performance.now();
    const highlightedMarks = marks.filter((p) => containsPoint(p, polygon)).length;
    const highlightMs = performance.now() - t;
    t = performance.now();
    const selected = await session.coordinator.query(
      `SELECT count(*) AS n FROM (${selectionSQL(source, { x: axis, y, polygon })})`,
      { cache: false }
    );
    const selectionRoundtripMs = performance.now() - t;
    const exact = backend.last!;
    // Exercise the existing paginated query-result path used by ECharts.
    await backend.request({ operation: "create", shapeId: "shape:legacy", sql: source });
    const raw = await backend.request({
      operation: "page",
      shapeId: "shape:legacy",
      offset: 0,
      limit: Math.min(n, 10000),
    });
    t = performance.now();
    const bytes = Buffer.from(raw.ipc!, "base64");
    const data = tableFromIPC(bytes)
      .toArray()
      .map((row) => row.toJSON());
    const legacyDecodeMs = performance.now() - t;
    const render = [];
    for (const copies of [1, 10, 30]) {
      t = performance.now();
      let nativeChars = 0;
      for (let i = 0; i < copies; i++)
        nativeChars += renderToStaticMarkup(
          <>
            <ScatterMarks
              marks={marks}
              geometry={geometry}
              plan={plan}
              polygon={null}
              width={592}
              height={268}
              renderer="svg"
            />
            <ScatterAxes geometry={geometry} width={592} height={268} xLabel="x" yLabel="y" polygon={null} />
          </>
        ).length;
      const nativeSvgMs = performance.now() - t;
      t = performance.now();
      let legacyChars = 0;
      for (let i = 0; i < copies; i++) {
        const chart = echarts.init(null, undefined, { renderer: "svg", ssr: true, width: 592, height: 268 });
        chart.setOption({
          ...buildChartOption({
            chartHeight: 400,
            chartType: "scatter",
            x: "x",
            y: "y",
            color: null,
            columnTypes: { id: "BIGINT", x: "DOUBLE", y: "DOUBLE" },
            data,
            isStacked: false,
            resolvedYAxisScale: "auto",
          }),
          animation: false,
        });
        legacyChars += chart.renderToSVGString().length;
        chart.dispose();
      }
      render.push({ copies, nativeSvgMs, legacySvgMs: performance.now() - t, nativeChars, legacyChars });
    }
    rows.push({
      n,
      marks: table.numRows,
      mode: plan.mode,
      statsMs,
      planningMs,
      plotRoundtripMs,
      queryMs: plot.queryMs,
      serializationMs: plot.serializationMs,
      arrowBytes: Buffer.from(plot.ipc!, "base64").byteLength,
      // Pipe transport and scheduling are included; not labelled pure decoding.
      pipeDecodeScheduleMs: plotRoundtripMs - plot.queryMs - (plot.serializationMs ?? 0),
      cacheMs,
      highlightMs,
      highlightedMarks,
      selected: Number(selected.toArray()[0].n),
      selectionRoundtripMs,
      selectionQueryMs: exact.queryMs,
      legacyRows: data.length,
      legacyQueryMs: raw.queryMs,
      legacySerializationMs: raw.serializationMs,
      legacyBytes: bytes.byteLength,
      legacyDecodeMs,
      render,
    });
  }
  const output = {
    environment: { node: process.version, platform: process.platform, architecture: process.arch },
    method:
      "Single warm process; one timing per case. SVG string generation only, no browser. Native uses all observations through bins; ECharts uses its current first-10000-row limit.",
    memory: process.memoryUsage(),
    rows,
  };
  await writeFile(resolve(process.cwd(), "../docs/visualization/node-results.json"), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
} finally {
  session.dispose();
  backend.close();
}
