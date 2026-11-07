import { atom, type Editor, type TLShapeId } from "tldraw";
import { backendRevision } from "../client/backendCompute";
import type { LocalServerContextType } from "../client/localServer/types";
import { buildRemoteSQLFromDag } from "../SQLTextArea/walkSQLDag";
import { quoteIdentifier } from "../src/duckdb/sql";
import { randomUUID } from "../util/randomUUID";
import type { DataSourceShape } from "./data-source-types";
import { getRemoteSourceMetadata } from "./remote-source-metadata";

type SampleRowCount = {
  key: string;
  status: "loading" | "ready" | "error";
  promise: Promise<bigint>;
  count?: bigint;
  error?: string;
};

function createCounts() {
  return atom<ReadonlyMap<TLShapeId, SampleRowCount>>("Sample row counts", new Map());
}
const countsByEditor = new WeakMap<Editor, ReturnType<typeof createCounts>>();
function getCounts(editor: Editor) {
  let counts = countsByEditor.get(editor);
  if (!counts) {
    counts = createCounts();
    countsByEditor.set(editor, counts);
  }
  return counts;
}

export function sampleRowCountKey(shape: DataSourceShape): string {
  return JSON.stringify([
    backendRevision.get(),
    shape.id,
    shape.props.name,
    getRemoteSourceMetadata(shape),
    shape.props.samplePercent ?? 100,
  ]);
}

export function getSampleRowCount(editor: Editor, shape: DataSourceShape): SampleRowCount | undefined {
  const entry = getCounts(editor).get().get(shape.id);
  return entry?.key === sampleRowCountKey(shape) ? entry : undefined;
}

export function loadSampleRowCount(
  editor: Editor,
  shape: DataSourceShape,
  runRemoteQuery: LocalServerContextType["runRemoteQuery"],
  refresh = false
): Promise<bigint> {
  const existing = getSampleRowCount(editor, shape);
  if (existing?.status === "loading" || (existing?.status === "ready" && !refresh)) return existing.promise;
  const key = sampleRowCountKey(shape);
  const counts = getCounts(editor);
  const promise = (async () => {
    const percent = shape.props.samplePercent ?? 100;
    if (percent === 0) return 0n;
    const source = getRemoteSourceMetadata(shape);
    if (!source) throw new Error("The sampled source is unavailable.");
    // Use the same sampling SQL and execution engine as downstream queries.
    const sql = buildRemoteSQLFromDag(
      `SELECT COUNT(*) AS sampled_row_count FROM ${quoteIdentifier(shape.props.name)}`,
      [shape],
      editor
    );
    const output = await runRemoteQuery({
      sql,
      sourceName: source.sourceName,
      sourceType: source.sourceType,
      sourceNative: true,
      shapeId: `sample-count:${randomUUID()}`,
      queryName: `${shape.props.name} sampled rows`,
      transient: true,
    });
    const count = output.sampleRows[0]?.sampled_row_count;
    if (
      (typeof count !== "bigint" && typeof count !== "number" && typeof count !== "string") ||
      (typeof count === "number" && !Number.isSafeInteger(count)) ||
      !/^\d+$/.test(String(count))
    )
      throw new Error("The query did not return a valid sampled row count.");
    return BigInt(count);
  })();
  const entry: SampleRowCount = { key, status: "loading", promise };
  counts.set(new Map(counts.get()).set(shape.id, entry));
  const finish = (update: Partial<SampleRowCount>) => {
    if (counts.get().get(shape.id) === entry) {
      counts.set(new Map(counts.get()).set(shape.id, { ...entry, ...update }));
    }
  };
  void promise.then(
    (count) => finish({ status: "ready", count }),
    (error: unknown) => {
      console.error("Failed to count sampled rows", error);
      finish({ status: "error", error: error instanceof Error ? error.message : String(error) });
    }
  );
  return promise;
}
