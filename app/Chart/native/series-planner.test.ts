import assert from "node:assert/strict";
import test from "node:test";
import { createVisualizationSession } from "./coordinator.ts";
import { testBackend } from "./test-backend.ts";
import { planLineRun, planBars } from "./series-planner.ts";

test("Mosaic M4 keeps extrema and run identities; bars aggregate in DuckDB and signal cardinality overflow", async () => {
  const backend = testBackend();
  const session = createVisualizationSession(backend.execute);
  try {
    const source = "SELECT * FROM (VALUES (0,2,0),(1,100,0),(2,-20,0),(3,4,0),(5,6,1),(6,9,1)) AS t(x,y,run)";
    const result = await session.coordinator.query(planLineRun(source, "x", "y", "run", 0, 10, 1));
    const rows = result.toArray().map((r) => ({ x: Number(r.x), y: Number(r.y), run: Number(r.run) }));
    assert.deepEqual(rows, [
      { x: 0, y: 2, run: 0 },
      { x: 1, y: 100, run: 0 },
      { x: 2, y: -20, run: 0 },
      { x: 3, y: 4, run: 0 },
      { x: 5, y: 6, run: 1 },
      { x: 6, y: 9, run: 1 },
    ]);
    const bars = await session.coordinator.query(
      planBars("SELECT * FROM (VALUES ('a',1),('a',2),('b',4),('c',9)) AS t(k,v)", "k", "v", 2)
    );
    assert.equal(bars.numRows, 3, "extra category tells caller to reject or explicitly reduce");
    assert.deepEqual(
      bars.toArray().map((r) => [r.category, Number(r.value)]),
      [
        ["a", 3],
        ["b", 4],
        ["c", 9],
      ]
    );
  } finally {
    session.dispose();
    backend.close();
  }
});
