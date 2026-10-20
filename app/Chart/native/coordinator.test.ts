import assert from "node:assert/strict";
import test from "node:test";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { createVisualizationSession } from "./coordinator.ts";
import { MosaicClient, Selection } from "@uwdata/mosaic-core";
import { Query, verbatim, type FilterExpr } from "@uwdata/mosaic-sql";
import { selectionPredicate } from "./selection.ts";
import { testBackend } from "./test-backend.ts";

const bytes = tableToIPC(tableFromArrays({ n: [42] }));
test("real Mosaic decodes Arrow, deduplicates requests and caches by revision-qualified SQL", async () => {
  let calls = 0;
  const session = createVisualizationSession(async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return bytes;
  });
  try {
    const a = session.coordinator.query("/* revision 1 */ SELECT 42 AS n");
    const b = session.coordinator.query("/* revision 1 */ SELECT 42 AS n");
    assert.equal((await a).toArray()[0].n, 42);
    await b;
    await session.coordinator.query("/* revision 1 */ SELECT 42 AS n");
    assert.equal(calls, 1);
    await session.coordinator.query("/* revision 2 */ SELECT 42 AS n");
    assert.equal(calls, 2);
    await session.coordinator.query("SELECT 42 AS n", { cache: false });
    await session.coordinator.query("SELECT 42 AS n", { cache: false });
    assert.equal(calls, 4, "live counts are never cached");
  } finally {
    session.dispose();
  }
});

test("thin adapter aborts live selection requests and closing a session aborts all HTTP work", async () => {
  let aborted = 0;
  const session = createVisualizationSession(
    async (_sql, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted++;
            reject(new Error("aborted"));
          },
          { once: true }
        );
      })
  );
  const controller = new AbortController();
  const first = session.coordinator.query("SELECT 1", { cache: false, signal: controller.signal });
  const rejection = assert.rejects(first, /aborted/);
  controller.abort();
  await rejection;
  assert.equal(aborted, 1);
  const second = session.coordinator.query("SELECT 2", { cache: false });
  const closed = assert.rejects(second);
  session.dispose();
  await closed;
  assert.equal(aborted, 2);
});

test("Mosaic 0.33 cancellation rejects a consumer but does not abort a shared connector request", async () => {
  let resolve!: (bytes: Uint8Array) => void;
  let aborted = false;
  const session = createVisualizationSession(async (_sql, signal) => {
    signal.addEventListener("abort", () => {
      aborted = true;
    });
    return new Promise<Uint8Array>((done) => {
      resolve = done;
    });
  });
  const first = session.coordinator.query("SELECT 42");
  const second = session.coordinator.query("SELECT 42");
  const rejected = assert.rejects(first);
  session.coordinator.cancel([first]);
  await rejected;
  assert.equal(aborted, false);
  resolve(bytes);
  assert.equal((await second).toArray()[0].n, 42);
  session.dispose();
});

test("two arbitrary clients coordinate through a Mosaic polygon Selection without a rendering library", async () => {
  const backend = testBackend();
  const session = createVisualizationSession(backend.execute);
  const filters = Selection.single();
  class Client extends MosaicClient {
    rows = -1;
    override query(filter?: FilterExpr | null) {
      return Query.from(verbatim("(SELECT * FROM (VALUES (0.2,0.2), (0.8,0.8)) AS data(x,y)) AS observation"))
        .select("*")
        .where(filter ?? []);
    }
    override queryResult(table: unknown) {
      this.rows = (table as { numRows: number }).numRows;
      return this;
    }
  }
  const a = new Client(filters),
    b = new Client(filters);
  try {
    session.coordinator.connect(a);
    session.coordinator.connect(b);
    await Promise.all([a.pending, b.pending]);
    assert.equal(a.rows, 2);
    assert.equal(b.rows, 2);
    const predicate = selectionPredicate({
      x: { field: "x", type: "linear", domain: [0, 1] },
      y: { field: "y", type: "linear", domain: [0, 1] },
      polygon: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
      ],
    });
    filters.update({
      source: {},
      fields: [],
      value: "triangle",
      predicate: verbatim(predicate),
      meta: { type: "polygon" },
    });
    // Param emits asynchronously; allow its microtask before awaiting clients.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await Promise.all([a.pending, b.pending]);
    assert.equal(a.rows, 1);
    assert.equal(b.rows, 1);
  } finally {
    session.dispose();
    backend.close();
  }
});
