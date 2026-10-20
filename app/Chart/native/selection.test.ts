import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { tableFromIPC } from "apache-arrow";
import { polygonContains } from "d3";
import { createVisualizationSession } from "./coordinator.ts";
import { testBackend } from "./test-backend.ts";
import { chartGeometry, drawingToPlotPoints, linePath, barBands } from "./geometry.ts";
import { containsPoint, normalize, selectionSQL, validatePolygon, type Point, type Axis } from "./selection.ts";
import { planScatter } from "./planner.ts";

const axis: Axis = { field: "x", type: "linear", domain: [0, 1] };
const triangle: Point[] = [
  { x: 0.1, y: 0.1 },
  { x: 0.9, y: 0.1 },
  { x: 0.1, y: 0.9 },
];
const selection = { x: axis, y: { ...axis, field: "y" }, polygon: triangle };

test("DuckDB polygon row sets match independent oracle, including duplicates, boundaries and invalids", async () => {
  const backend = testBackend();
  const { coordinator, dispose } = createVisualizationSession(backend.execute);
  try {
    const rows: (Point & { id: number })[] = [];
    for (let i = 0; i < 400; i++) rows.push({ id: i, x: ((i * 7919) % 997) / 997, y: ((i * 3571) % 991) / 991 });
    rows.push({ id: 400, x: 0.1, y: 0.1 }, { id: 401, x: 0.1, y: 0.1 }, { id: 402, x: 0.4, y: 0.1 });
    const source = `SELECT * FROM (VALUES ${rows.map((p) => `(${p.id}, ${p.x}, ${p.y})`).join(",")},
      (403, NULL, 0.2), (404, 'Infinity'::DOUBLE, 0.2), (405, 'NaN'::DOUBLE, 0.2)) AS input(id,x,y)`;
    const polygonTuples = triangle.map((p) => [p.x, p.y] as [number, number]);
    const expected = rows.filter((p) => p.id >= 400 || polygonContains(polygonTuples, [p.x, p.y])).map((p) => p.id);
    const table = await coordinator.query(`${selectionSQL(source, selection)} ORDER BY id`, { cache: false });
    assert.deepEqual(
      table.toArray().map((row) => Number(row.id)),
      expected
    );
    for (const polygon of [
      [
        { x: 0.2, y: 0.2 },
        { x: 0.8, y: 0.8 },
        { x: 0.2, y: 0.8 },
        { x: 0.8, y: 0.2 },
      ],
      [
        { x: 0.333, y: 0 },
        { x: 0.33300001, y: 1 },
        { x: 0.334, y: 0 },
      ],
      [
        { x: 2, y: 2 },
        { x: 3, y: 2 },
        { x: 2, y: 3 },
      ],
    ]) {
      const actual = await coordinator.query(`${selectionSQL(source, { ...selection, polygon })} ORDER BY id`, {
        cache: false,
      });
      const tuples = polygon.map((p) => [p.x, p.y] as [number, number]);
      assert.deepEqual(
        actual.toArray().map((row) => Number(row.id)),
        rows.filter((p) => polygonContains(tuples, [p.x, p.y])).map((p) => p.id)
      );
    }
    const single = await coordinator.query(selectionSQL("SELECT 1 AS id, 0.2 AS x, 0.2 AS y", selection));
    assert.equal(single.numRows, 1);
  } finally {
    dispose();
    backend.close();
  }
});

test("million-row acceptance: density reduction and executable result view retain all and only qualifying observations", async () => {
  const backend = testBackend();
  const session = createVisualizationSession(backend.execute);
  try {
    // Ten duplicates per grid coordinate. Integer oracle avoids floating ray
    // casting and has an independently derived closed-form count.
    const source = `SELECT i AS id, (i % 1000)::DOUBLE / 1000 AS x,
      (floor(i / 1000) % 100)::DOUBLE / 100 AS y FROM range(1000000) AS t(i)`;
    const s = {
      ...selection,
      polygon: [
        { x: 0, y: 0 },
        { x: 0.5, y: 0 },
        { x: 0, y: 0.5 },
      ],
    };
    const plan = planScatter(source, s.x, s.y, 1000000, 510, 246);
    assert.equal(plan.mode, "density");
    const plotted = await session.coordinator.query(plan.sql);
    assert.ok(plotted.numRows <= plan.columns * plan.rows);
    assert.equal(
      plotted.toArray().reduce((n, row) => n + Number(row.count), 0),
      1000000
    );
    const generated = selectionSQL(source, s);
    const oracle = `${source} WHERE (i % 1000) + 10*(floor(i/1000) % 100) <= 500`;
    const difference = await session.coordinator.query(`SELECT count(*) AS n FROM (
      ((${generated}) EXCEPT ALL (${oracle})) UNION ALL ((${oracle}) EXCEPT ALL (${generated})))`);
    assert.equal(Number(difference.toArray()[0].n), 0, "both directions of EXCEPT ALL must be empty");
    const result = await backend.request({ operation: "create", shapeId: "shape:lasso-acceptance", sql: generated });
    assert.equal(result.rowCount, 128010);
    assert.ok(result.rowCount! > plotted.numRows);
    const page = await backend.request({
      operation: "page",
      shapeId: "shape:lasso-acceptance",
      offset: 128000,
      limit: 10,
    });
    const tail = tableFromIPC(Buffer.from(page.ipc!, "base64"));
    assert.equal(tail.numRows, 10, "pagination reaches the complete selected result");
  } finally {
    session.dispose();
    backend.close();
  }
});

test("log/reversed axes use transformed observations, with clipped domains and quoted column names", async () => {
  const backend = testBackend();
  const session = createVisualizationSession(backend.execute);
  try {
    const x: Axis = { field: 'x"odd', type: "log", domain: [1000, 1] };
    const y: Axis = { field: "y", type: "linear", domain: [1, 0] };
    const polygon = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ];
    const points = [
      { id: 1, x: 100, y: 0.5 },
      { id: 2, x: 2, y: 0.5 },
      { id: 3, x: 10, y: 0.9 },
      { id: 4, x: -1, y: 1 },
      { id: 5, x: 0, y: 1 },
      { id: 6, x: 10000, y: 1 },
    ];
    const source = `SELECT * FROM (VALUES ${points.map((p) => `(${p.id},${p.x},${p.y})`).join(",")}) AS source(id,"x""odd",y)`;
    const expected = points
      .filter((p) => {
        const point = { x: normalize(p.x, x), y: normalize(p.y, y) };
        return point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1 && containsPoint(point, polygon);
      })
      .map((p) => p.id);
    const result = await session.coordinator.query(selectionSQL(source, { x, y, polygon }) + " ORDER BY id");
    assert.deepEqual(
      result.toArray().map((row) => Number(row.id)),
      expected
    );
    assert.deepEqual(expected, [1, 3]);
  } finally {
    session.dispose();
    backend.close();
  }
});

test("geometry is invertible across aspect ratios; renderer and LOD never enter the analytical selection", () => {
  const before = selectionSQL("SELECT * FROM observations", selection);
  for (const [width, height] of [
    [240, 900],
    [1600, 200],
    [600, 400],
  ]) {
    const geometry = chartGeometry(width, height, selection.x, selection.y);
    for (const p of triangle) {
      const transformed = geometry.toAnalytical(geometry.project(p));
      assert.ok(Math.abs(p.x - transformed.x) < 1e-14);
      assert.ok(Math.abs(p.y - transformed.y) < 1e-14);
    }
    for (const count of [100, 10000000]) {
      planScatter("SELECT * FROM observations", selection.x, selection.y, count, width, height);
      assert.equal(selectionSQL("SELECT * FROM observations", selection), before);
    }
  }
  assert.throws(
    () =>
      validatePolygon([
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ]),
    /three/
  );
  assert.throws(
    () =>
      validatePolygon([
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 2, y: 2 },
      ]),
    /area/
  );
  assert.throws(
    () =>
      validatePolygon([
        { x: NaN, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
      ]),
    /finite/
  );
  const geometry = chartGeometry(600, 400, selection.x, selection.y);
  assert.ok(linePath([{ x: 0, y: 0 }, null, { x: 1, y: 1 }], geometry.project)?.includes("M"));
  assert.ok(barBands(["a", "b"], 500).bandwidth() > 0);
});

test("complete 64-edge freehand region on a million rows matches an independent point oracle", async () => {
  const backend = testBackend();
  const session = createVisualizationSession(backend.execute);
  try {
    const polygon = Array.from({ length: 64 }, (_, i) => ({
      x: 0.5 + 0.217 * Math.cos((i * 2 * Math.PI) / 64 + 0.013),
      y: 0.5 + 0.217 * Math.sin((i * 2 * Math.PI) / 64 + 0.013),
    }));
    const tuples = polygon.map((p) => [p.x, p.y] as [number, number]);
    let expected = 0;
    for (let i = 0; i < 100000; i++)
      if (polygonContains(tuples, [(i % 1000) / 1000, Math.floor(i / 1000) / 100])) expected += 10;
    const source =
      "SELECT i AS id, (i%1000)::DOUBLE/1000 AS x, (floor(i/1000)%100)::DOUBLE/100 AS y FROM range(1000000) t(i)";
    const result = await session.coordinator.query(
      `SELECT count(*) AS n FROM (${selectionSQL(source, { ...selection, polygon })})`,
      { cache: false }
    );
    assert.equal(Number(result.toArray()[0].n), expected);
  } finally {
    session.dispose();
    backend.close();
  }
});

test("live selection re-evaluates changed source rows and revision keys prevent stale visualization data", async () => {
  const backend = testBackend();
  const session = createVisualizationSession(backend.execute);
  const shapeId = "shape:live-fixture";
  const view = `_kavla_result_${createHash("sha256").update(shapeId).digest("hex").slice(0, 32)}`;
  try {
    await backend.request({ operation: "create", shapeId, sql: "SELECT 1 AS id, 0.2 AS x, 0.2 AS y" });
    const selected = `SELECT count(*) AS n FROM (${selectionSQL(`SELECT * FROM "${view}"`, selection)})`;
    assert.equal(Number((await session.coordinator.query(selected, { cache: false })).toArray()[0].n), 1);
    await session.coordinator.query(`/* revision 1 */ SELECT count(*) AS n FROM "${view}"`);
    await backend.request({
      operation: "create",
      shapeId,
      sql: "SELECT * FROM (VALUES (1,0.2,0.2), (2,0.3,0.3), (3,0.9,0.9)) t(id,x,y)",
    });
    assert.equal(Number((await session.coordinator.query(selected, { cache: false })).toArray()[0].n), 2);
    assert.equal(
      Number((await session.coordinator.query(`/* revision 2 */ SELECT count(*) AS n FROM "${view}"`)).toArray()[0].n),
      3
    );
  } finally {
    session.dispose();
    backend.close();
  }
});

test("drawing/page/chart transforms preserve the same analytical polygon after moving and rotating", () => {
  for (const [width, height] of [
    [320, 800],
    [1000, 320],
  ]) {
    const geometry = chartGeometry(width, height, selection.x, selection.y);
    const offset = { x: 4, y: 46 };
    const local = triangle.map((p) => {
      const q = geometry.fromAnalytical(p);
      return { x: q.x + offset.x, y: q.y + offset.y };
    });
    const c = Math.cos(0.7),
      s = Math.sin(0.7);
    const toPage = (p: Point) => ({ x: 1723 + p.x * c - p.y * s, y: -840 + p.x * s + p.y * c });
    const toChart = (p: Point) => ({ x: (p.x - 1723) * c + (p.y + 840) * s, y: -(p.x - 1723) * s + (p.y + 840) * c });
    const actual = drawingToPlotPoints(local, toPage, toChart, offset).map(geometry.toAnalytical);
    actual.forEach((p, i) => {
      assert.ok(Math.abs(p.x - triangle[i].x) < 1e-13);
      assert.ok(Math.abs(p.y - triangle[i].y) < 1e-13);
    });
  }
});
