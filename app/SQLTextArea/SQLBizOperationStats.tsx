import { useMemo } from "react";
import type { SQLTextAreaShape } from "./sql-text-area-types";
import { useSQLBizStats } from "./useSQLBizStats";
import { readBizOperationStats, type BizOperationStatsPlan } from "./sqlBizOperationStats";
import { formatBizFilterCount } from "./sqlBizFilterStats";

function percentage(rows: number, input: number, meaning: string) {
  const title = `${rows.toLocaleString()} of ${input.toLocaleString()} rows ${meaning}`;
  return (
    <span
      title={title}
      aria-label={title}
      tabIndex={0}
      style={{ cursor: "help", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}
    >
      {(input ? (rows / input) * 100 : 0).toLocaleString(undefined, { maximumFractionDigits: 1 })}%
    </span>
  );
}

export function SQLBizOperationStats({
  shape,
  plan,
  popup = false,
}: {
  shape: SQLTextAreaShape;
  plan: BizOperationStatsPlan;
  popup?: boolean;
}) {
  const { state, retry } = useSQLBizStats(
    shape,
    "error" in plan ? null : plan.sql,
    "error" in plan ? plan.error : undefined
  );
  const result = useMemo(() => {
    if (state.status !== "ready" || "error" in plan) return null;
    try {
      return { stats: readBizOperationStats(plan.kind, state.rows) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [state, plan]);
  const stats = result && "stats" in result ? result.stats : null;
  const error = state.status === "error" ? state.error : result && "error" in result ? result.error : null;
  const beforeAfter =
    stats && (stats.kind === "aggregate" || stats.kind === "deduplicate")
      ? `${stats.input.toLocaleString()} → ${stats.output.toLocaleString()} rows`
      : "";
  return (
    <div
      aria-live="polite"
      style={{ marginTop: 6, fontSize: popup ? 12 : 10, lineHeight: popup ? "20px" : "14px", overflowWrap: "anywhere" }}
    >
      {!stats && !error && (
        <span style={{ color: "#666" }}>{state.status === "waiting" ? "Waiting for query…" : "Counting…"}</span>
      )}
      {error && (
        <div style={{ color: "#b91c1c" }}>
          {error}
          {popup && !("error" in plan) && (
            <button type="button" onClick={retry} className="ml-2 underline cursor-pointer">
              Retry
            </button>
          )}
        </div>
      )}
      {stats?.kind === "aggregate" && (
        <div title="Rows entering aggregation → groups, before HAVING and row limits">{beforeAfter}</div>
      )}
      {stats?.kind === "deduplicate" &&
        (popup ? (
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
            <span title={beforeAfter}>Removed</span>
            {percentage(stats.input - stats.output, stats.input, "removed by DISTINCT")}
          </div>
        ) : (
          <div>{formatBizFilterCount(stats.input - stats.output, stats.input)}</div>
        ))}
      {stats?.kind === "join" &&
        (popup ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", columnGap: 12 }}>
            <span>Left matched</span>
            {percentage(stats.leftMatched, stats.left, "matched at least once")}
            <span>Right matched</span>
            {percentage(stats.rightMatched, stats.right, "matched at least once")}
          </div>
        ) : (
          <div>{percentage(stats.leftMatched, stats.left, "matched at least once")} left matched</div>
        ))}
      {stats?.kind === "buckets" && (
        <>
          <div title={`${stats.input.toLocaleString()} input rows`}>
            {stats.count.toLocaleString()} {stats.count === 1 ? "bucket" : "buckets"}
          </div>
          {popup && (
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: "2px 12px", marginTop: 4 }}>
              {stats.buckets.map((bucket, index) => (
                <div key={index} style={{ display: "contents" }}>
                  <span
                    title={
                      bucket.other
                        ? `${Math.max(0, stats.count - 8).toLocaleString()} remaining buckets`
                        : bucket.isNull
                          ? "SQL NULL"
                          : bucket.label
                    }
                    style={{
                      position: "relative",
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontFamily: bucket.other ? undefined : "monospace",
                      fontStyle: bucket.other || bucket.isNull ? "italic" : undefined,
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        position: "absolute",
                        inset: "1px auto 1px 0",
                        width: `${stats.input ? (bucket.rows / stats.input) * 100 : 0}%`,
                        background: "#f0f0f0",
                        borderRadius: 2,
                      }}
                    />
                    <span style={{ position: "relative" }}>
                      {bucket.isNull ? "NULL" : bucket.other ? "Other" : JSON.stringify(bucket.label)}
                    </span>
                  </span>
                  {percentage(bucket.rows, stats.input, "in this bucket")}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
