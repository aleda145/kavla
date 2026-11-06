import { useEffect, useRef, useState } from "react";
import { type Editor, useValue } from "tldraw";
import { backendRevision } from "../client/backendCompute";
import type { LocalServerContextType } from "../client/localServer/types";
import { buildRemoteSQLFromDag } from "../SQLTextArea/walkSQLDag";
import { quoteIdentifier } from "../src/duckdb/sql";
import { randomUUID } from "../util/randomUUID";
import type { DataSourceShape } from "./data-source-types";
import { getDataSourceExecutionMetadata } from "./source-samples";

export function SampledRowCount({
  editor,
  shape,
  runRemoteQuery,
}: {
  editor: Editor;
  shape: DataSourceShape;
  runRemoteQuery: LocalServerContextType["runRemoteQuery"];
}) {
  const revision = useValue("Sample row count revision", () => backendRevision.get(), []);
  const source = getDataSourceExecutionMetadata(shape);
  const percent = shape.props.samplePercent ?? 100;
  const key = JSON.stringify([revision, shape.id, shape.props.name, source, percent]);
  const request = useRef<{ key: string; promise: Promise<bigint> } | null>(null);
  const [result, setResult] = useState<{ key: string; count?: bigint; error?: string } | null>(null);

  useEffect(() => {
    if (percent >= 100) {
      request.current = null;
      return;
    }
    let active = true;
    if (request.current?.key !== key) {
      const promise = (async () => {
        if (percent === 0) return 0n;
        const current = editor.getShape<DataSourceShape>(shape.id);
        if (!current || !source) throw new Error("The sampled source is unavailable.");
        // Use the same sampling SQL and execution engine as downstream queries.
        const sql = buildRemoteSQLFromDag(
          `SELECT COUNT(*) AS sampled_row_count FROM ${quoteIdentifier(current.props.name)}`,
          [current],
          editor
        );
        const output = await runRemoteQuery({
          sql,
          sourceName: source.sourceName,
          sourceType: source.sourceType,
          sourceNative: true,
          shapeId: `sample-count:${randomUUID()}`,
          queryName: `${current.props.name} sampled rows`,
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
      request.current = { key, promise };
    }
    void request.current.promise.then(
      (count) => {
        if (active) setResult({ key, count });
      },
      (error: unknown) => {
        if (active) {
          console.error("Failed to count sampled rows", error);
          setResult({ key, error: error instanceof Error ? error.message : String(error) });
        }
      }
    );
    return () => {
      // Let the transient query finish; aborting discards the compute worker.
      active = false;
    };
  }, [key, editor, runRemoteQuery]);

  if (percent >= 100) return null;
  const current = result?.key === key ? result : null;
  return (
    <div aria-live="polite" title={current?.error || "Count from the latest sample check"}>
      <strong>Sampled row count:</strong>{" "}
      {current?.count !== undefined ? `${current.count.toLocaleString()}~` : current?.error ? "—" : "…"}
    </div>
  );
}
