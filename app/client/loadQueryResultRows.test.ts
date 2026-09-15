import assert from "node:assert/strict";
import test from "node:test";
import { loadQueryResultRows } from "./loadQueryResultRows.ts";

test("loads the full result across multiple server pages", async () => {
  const source = Array.from({ length: 25017 }, (_, index) => ({ index }));
  const requests: { offset: number; limit: number }[] = [];
  const rows = await loadQueryResultRows(async ({ shapeId, offset, limit }) => {
    assert.equal(shapeId, "shape:query");
    requests.push({ offset, limit });
    return { rows: source.slice(offset, offset + limit) };
  }, "shape:query");
  assert.deepEqual(rows, source);
  assert.deepEqual(requests, [
    { offset: 0, limit: 10000 },
    { offset: 10000, limit: 10000 },
    { offset: 20000, limit: 10000 },
  ]);
});

test("handles an empty result and an exact page boundary", async () => {
  for (const size of [0, 20000]) {
    const source = Array.from({ length: size }, (_, index) => ({ index }));
    let requests = 0;
    const rows = await loadQueryResultRows(async ({ offset, limit }) => {
      requests++;
      return { rows: source.slice(offset, offset + limit) };
    }, "shape:query");
    assert.equal(rows.length, size);
    assert.equal(requests, size / 10000 + 1);
  }
});

test("preserves explicit preview and chart limits", async () => {
  for (const maximum of [5, 10001]) {
    const requests: { offset: number; limit: number }[] = [];
    const rows = await loadQueryResultRows(async ({ offset, limit }) => {
      requests.push({ offset, limit });
      return { rows: Array.from({ length: limit }, (_, index) => ({ index: offset + index })) };
    }, "shape:query", maximum);
    assert.equal(rows.length, maximum);
    assert.equal(requests.at(-1)!.offset + requests.at(-1)!.limit, maximum);
    assert.ok(requests.every(({ limit }) => limit <= 10000));
  }
});

test("cancellation stops pagination and reaches the active page request", async () => {
  const controller = new AbortController();
  let requests = 0;
  await assert.rejects(loadQueryResultRows(async ({ signal, limit }) => {
    requests++;
    assert.equal(signal, controller.signal);
    controller.abort();
    return { rows: Array.from({ length: limit }, () => ({})) };
  }, "shape:query", null, controller.signal), { name: "AbortError" });
  assert.equal(requests, 1);
});

test("a failed later page never returns a partial result", async () => {
  await assert.rejects(loadQueryResultRows(async ({ offset, limit }) => {
    if (offset > 0) throw new Error("Query result is unavailable");
    return { rows: Array.from({ length: limit }, () => ({})) };
  }, "shape:query"), /Query result is unavailable/);
});
