import { useMemo } from "react";
import type { SQLTextAreaShape } from "./sql-text-area-types";
import { useSQLBizStats } from "./useSQLBizStats";
import { readBizOperationStats, type BizOperationStatsPlan } from "./sqlBizOperationStats";
import { formatBizFilterCount } from "./sqlBizFilterStats";

function percentage(rows: number, input: number, meaning: string, unit = "rows") {
  const title = `${rows.toLocaleString()} of ${input.toLocaleString()} ${unit} ${meaning}`;
  return (
    <span
      title={title}
      aria-label={title}
      tabIndex={0}
      className="font-mono text-[10px] font-bold text-black tabular-nums"
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
  const reduction = stats && "output" in stats && stats.kind !== "aggregate" ? stats : null;
  const rowLimit = reduction?.kind === "limit" || reduction?.kind === "skip";
  return (
    <div
      aria-live="polite"
      className={popup ? "mt-2 border-t border-gray-200 pt-2 text-xs leading-5" : undefined}
      style={{
        marginTop: popup ? undefined : 6,
        fontSize: popup ? undefined : 10,
        lineHeight: popup ? undefined : "14px",
        overflowWrap: "anywhere",
      }}
    >
      {!stats && !error && (
        <span className="font-mono text-[10px] text-black">
          {state.status === "waiting" ? "Waiting for query…" : "Counting…"}
        </span>
      )}
      {error && (
        <div className="text-xs font-bold text-red-500">
          {error}
          {popup && !("error" in plan) && (
            <button
              type="button"
              onClick={retry}
              className="ml-2 h-7 px-2 rounded border-2 border-black bg-white text-xs font-bold text-black cursor-pointer hover:bg-gray-100"
            >
              Retry
            </button>
          )}
        </div>
      )}
      {stats?.kind === "aggregate" && (
        <div
          className={popup ? "font-mono text-[10px] font-bold text-black" : undefined}
          title="Rows entering aggregation → groups, before HAVING and row limits"
        >
          {beforeAfter}
        </div>
      )}
      {reduction &&
        !rowLimit &&
        (popup ? (
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
            <span className="font-mono text-xs text-black" title={beforeAfter}>
              {reduction.kind === "having" ? "Groups removed" : "Removed"}
            </span>
            {percentage(
              reduction.input - reduction.output,
              reduction.input,
              "removed",
              reduction.kind === "having" ? "groups" : "rows"
            )}
          </div>
        ) : (
          <div>
            {reduction.kind === "having" ? (
              <>
                {(reduction.input - reduction.output).toLocaleString()} groups removed ·{" "}
                {percentage(reduction.input - reduction.output, reduction.input, "removed", "groups")}
              </>
            ) : (
              formatBizFilterCount(reduction.input - reduction.output, reduction.input)
            )}
          </div>
        ))}
      {reduction &&
        rowLimit &&
        (popup ? (
          <div className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1">
            <span className="font-mono text-xs text-black">Retained</span>
            {percentage(reduction.output, reduction.input, "retained")}
            <span className="font-mono text-xs text-black">Discarded</span>
            {percentage(reduction.input - reduction.output, reduction.input, "discarded")}
          </div>
        ) : (
          <div>
            {reduction.output.toLocaleString()} / {reduction.input.toLocaleString()} rows retained
          </div>
        ))}
      {stats?.kind === "clean" &&
        (popup ? (
          <div className="flex justify-between items-center gap-2">
            <span className="font-mono text-xs text-black">Values changed</span>
            {percentage(stats.changed, stats.input, "changed by cleaning", "values")}
          </div>
        ) : (
          <div>
            {stats.changed.toLocaleString()} changed ·{" "}
            {percentage(stats.changed, stats.input, "changed by cleaning", "values")}
          </div>
        ))}
      {stats?.kind === "join" &&
        (popup ? (
          <div className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1">
            <span className="font-mono text-xs text-black">Left matched</span>
            {percentage(stats.leftMatched, stats.left, "matched at least once")}
            <span className="font-mono text-xs text-black">Right matched</span>
            {percentage(stats.rightMatched, stats.right, "matched at least once")}
          </div>
        ) : (
          <div>{percentage(stats.leftMatched, stats.left, "matched at least once")} left matched</div>
        ))}
      {stats?.kind === "buckets" && (
        <>
          <div
            className={
              popup
                ? "w-fit bg-white border border-black px-1.5 py-0.5 rounded text-[10px] leading-4 font-bold text-black shadow-[2px_2px_0px_0px_rgba(0,0,0,0.1)]"
                : undefined
            }
            title={`${stats.input.toLocaleString()} input rows`}
          >
            {stats.count.toLocaleString()} {stats.count === 1 ? "bucket" : "buckets"}
          </div>
          {popup && (
            <div className="mt-2 flex flex-col gap-1">
              {stats.buckets.map((bucket, index) => (
                <div key={index} className="flex items-center gap-2 h-5 w-full">
                  <span
                    title={
                      bucket.other
                        ? `${Math.max(0, stats.count - 8).toLocaleString()} remaining buckets`
                        : bucket.isNull
                          ? "SQL NULL"
                          : bucket.label
                    }
                    className={`w-[80px] shrink-0 font-mono text-xs truncate text-left ${bucket.other || bucket.isNull ? "italic text-black" : "text-black"}`}
                  >
                    {bucket.isNull ? "NULL" : bucket.other ? "Other" : bucket.label}
                  </span>
                  <div aria-hidden className="flex-1 min-w-0 h-3 bg-gray-100">
                    <div
                      className="h-full bg-yellow-300 border-2 border-black"
                      style={{ width: `${stats.input ? (bucket.rows / stats.input) * 100 : 0}%` }}
                    />
                  </div>
                  <span className="w-12 shrink-0 text-right">
                    {percentage(bucket.rows, stats.input, "in this bucket")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
