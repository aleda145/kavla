import { useMemo, type ReactNode } from "react";
import type { SQLTextAreaShape } from "./sql-text-area-types";
import { useSQLBizStats } from "./useSQLBizStats";
import { readBizOperationStats, type BizOperationStatsPlan } from "./sqlBizOperationStats";
import { formatBizFilterCount, formatBizPercentage } from "./sqlBizFilterStats";
import { SQLBizAnalysisControls } from "./SQLBizAnalysisControls";

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
      {formatBizPercentage(rows, input)}
    </span>
  );
}

export function SQLBizOperationStats({
  shape,
  plan,
  popup = false,
  highlight,
}: {
  shape: SQLTextAreaShape;
  plan: BizOperationStatsPlan;
  popup?: boolean;
  highlight?: (sql: string) => ReactNode;
}) {
  const analysis = useSQLBizStats(shape, "error" in plan ? null : plan.sql, "error" in plan ? plan.error : undefined);
  const { state } = analysis;
  const result = useMemo(() => {
    if (state.status !== "ready" || "error" in plan) return null;
    try {
      const stats = readBizOperationStats(
        plan.kind,
        state.rows,
        plan.kind === "aggregate" ? plan.aggregateNulls : undefined
      );
      if (stats.kind === "combine" && plan.kind === "combine") {
        const maximum =
          plan.operation === "UNION"
            ? stats.left + stats.right
            : plan.operation === "INTERSECT"
              ? Math.min(stats.left, stats.right)
              : stats.left;
        if (stats.output > maximum || (plan.operation === "UNION" && plan.all && stats.output !== maximum)) {
          throw new Error("Combined row counts are inconsistent. Run the analysis again.");
        }
      }
      return { stats };
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
  const reduction = stats && "output" in stats && stats.kind !== "aggregate" && stats.kind !== "combine" ? stats : null;
  const rowLimit = reduction?.kind === "limit" || reduction?.kind === "skip";
  const combine =
    stats?.kind === "combine" && !("error" in plan) && plan.kind === "combine"
      ? { ...stats, operation: plan.operation, all: plan.all }
      : null;
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
      {!stats && !error && state.status !== "idle" && (
        <span className="font-mono text-[10px] text-black">
          {state.status === "waiting" ? "Waiting for query…" : "Counting…"}
        </span>
      )}
      {error && <div className="text-xs font-bold text-red-500">{error}</div>}
      {stats?.kind === "aggregate" && (
        <div
          className={popup ? "font-mono text-[10px] font-bold text-black" : undefined}
          title="Rows entering aggregation → groups, before HAVING and row limits"
        >
          {beforeAfter}
        </div>
      )}
      {popup && stats?.kind === "aggregate" && stats.nulls.some((metric) => metric.skipped > 0) && (
        <div className="mt-1 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 text-black">
          {stats.nulls
            .filter((metric) => metric.skipped > 0)
            .map((metric) => (
              <div key={metric.label} style={{ display: "contents" }}>
                <span className="font-mono text-xs whitespace-pre-wrap">
                  {highlight ? highlight(metric.label) : metric.label}
                </span>
                <span className="font-mono text-[10px] whitespace-nowrap">
                  NULL skipped {percentage(metric.skipped, metric.input, "skipped because the aggregate input is NULL")}
                </span>
              </div>
            ))}
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
          <div className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1">
            <span className="font-mono text-xs text-black">Values changed</span>
            {percentage(stats.changed, stats.input, "changed by cleaning", "values")}
            {stats.nullReplaced !== undefined && stats.nullReplaced > 0 && (
              <>
                <span className="font-mono text-xs text-black">NULLs replaced</span>
                {percentage(
                  stats.nullReplaced,
                  stats.input,
                  "changed from NULL to a value; included in values changed",
                  "values"
                )}
              </>
            )}
            {stats.nullCreated !== undefined && stats.nullCreated > 0 && (
              <>
                <span className="font-mono text-xs text-black">Made NULL</span>
                {percentage(
                  stats.nullCreated,
                  stats.input,
                  "changed from a value to NULL; included in values changed",
                  "values"
                )}
              </>
            )}
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
      {combine &&
        (popup ? (
          <div className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1 text-black">
            <span className="font-mono text-xs">Left input</span>
            <span className="font-mono text-[10px] font-bold text-right tabular-nums" title="Rows from the left input">
              {combine.left.toLocaleString()}
            </span>
            <span className="font-mono text-xs">Right input</span>
            <span className="font-mono text-[10px] font-bold text-right tabular-nums" title="Rows from the right input">
              {combine.right.toLocaleString()}
            </span>
            <span className="font-mono text-xs">Output</span>
            <span
              className="font-mono text-[10px] font-bold text-right tabular-nums"
              title="Output rows before following SKIP or LIMIT"
            >
              {combine.output.toLocaleString()}
            </span>
            {!(combine.operation === "UNION" && combine.all) && (
              <>
                <span className="font-mono text-xs">
                  {combine.operation === "UNION" ? "Duplicates removed" : "Left removed"}
                </span>
                <span className="text-right">
                  {percentage(
                    (combine.operation === "UNION" ? combine.left + combine.right : combine.left) - combine.output,
                    combine.operation === "UNION" ? combine.left + combine.right : combine.left,
                    combine.operation === "UNION"
                      ? "removed as duplicates"
                      : `removed from the left input by ${combine.operation}${combine.all ? " ALL" : " (including duplicates)"}`
                  )}
                </span>
              </>
            )}
          </div>
        ) : (
          <div
            title={`${combine.left.toLocaleString()} left input rows · ${combine.right.toLocaleString()} right input rows`}
          >
            {combine.output.toLocaleString()} output rows
          </div>
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
                        ? `${Math.max(0, stats.count - stats.buckets.filter((item) => !item.other).length).toLocaleString()} remaining buckets`
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
      {popup && !("error" in plan) && <SQLBizAnalysisControls {...analysis} loading={state.status === "loading"} />}
    </div>
  );
}
