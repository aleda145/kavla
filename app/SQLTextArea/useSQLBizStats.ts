import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { atom, createShapeId, useEditor, useValue, type Editor } from "tldraw";
import { backendRevision } from "../client/backendCompute";
import { useData } from "../client/useLocalServer";
import { buildRemoteSQLFromDag, walkSQLDag } from "./walkSQLDag";
import { readBizFilterCounts, type BizFilterCounts, type BizFilterPlan } from "./sqlBizFilterStats";
import type { SQLTextAreaShape } from "./sql-text-area-types";
import type { RunRemoteQueryPayload } from "../client/localServer/types";

import { getRemoteSourceMetadata } from "../DataSource/remote-source-metadata";
import { getRemoteHoverPolicy, setRemoteHoverPolicy, subscribeRemoteHoverPolicy } from "./remote-hover-policy";

type AnalysisSource = { sourceName: string; sourceType: string | null };

type StatsState =
  | { status: "idle" | "loading" | "waiting" }
  | { status: "error"; error: string }
  | { status: "ready"; rows: Record<string, unknown>[] };
type Request =
  | { status: "waiting" }
  | { status: "error"; error: string }
  | { status: "ready"; payload: Omit<RunRemoteQueryPayload, "shapeId">; revision: string; sources: AnalysisSource[] };

type CacheEntry = { state: StatsState; shapeId: string; cancelled?: boolean };
const caches = new WeakMap<Editor, Map<string, CacheEntry>>();
const cacheRevision = atom("Biz stats cache revision", 0);
function notifyCache() {
  cacheRevision.set(cacheRevision.get() + 1);
}
// A successful run replaces this object, even if its row count and duration match.
const runRevisions = new WeakMap<object, number>();
let nextRunRevision = 0;
function runRevision(stats: SQLTextAreaShape["props"]["lastRunStats"]) {
  if (!stats) return 0;
  let revision = runRevisions.get(stats);
  if (revision === undefined) {
    revision = ++nextRunRevision;
    runRevisions.set(stats, revision);
  }
  return revision;
}

export function useSQLBizFilterStats(shape: SQLTextAreaShape, plan: BizFilterPlan, perCondition: boolean) {
  const query = "error" in plan ? plan.error : perCondition ? plan.conditionsSQL : plan.totalSQL;
  const result = useSQLBizStats(
    shape,
    "error" in plan ? null : query,
    "error" in plan ? query : undefined,
    perCondition && !("error" in plan) ? plan.totalSQL : undefined
  );
  const state = useMemo((): Exclude<StatsState, { status: "ready" }> | { status: "ready"; counts: BizFilterCounts } => {
    if (result.state.status !== "ready") return result.state;
    try {
      if (result.state.rows.length !== 1) throw new Error("Expected one row of filter counts.");
      return {
        status: "ready",
        counts: readBizFilterCounts(
          result.state.rows[0],
          perCondition && !("error" in plan) ? plan.conditions.length : 0
        ),
      };
    } catch (error) {
      return { status: "error", error: error instanceof Error ? error.message : String(error) };
    }
  }, [result.state, plan, perCondition]);
  return { ...result, state };
}

export function useSQLBizStats(shape: SQLTextAreaShape, sql: string | null, error?: string, cacheAlsoSQL?: string) {
  const editor = useEditor();
  const { runRemoteQuery, cancelRemoteQuery } = useData();
  const requestKeys = useValue(
    "Biz operation stats input",
    () => {
      const build = (sql: string | null): Request => {
        if (error) return { status: "error", error };
        if (!sql) return { status: "waiting" };
        try {
          const current = editor.getShape<SQLTextAreaShape>(shape.id);
          if (!current || current.props.text !== shape.props.text) return { status: "waiting" };
          const dag = walkSQLDag(editor, sql);
          if (!dag.ok) throw new Error(dag.error.message);
          if (dag.plan.orderedDependencies.some((input) => input.id === shape.id)) {
            throw new Error("Cannot measure this operation because its source resolves back to the current query.");
          }
          const queries = [
            current,
            ...dag.plan.orderedDependencies.filter(
              (input): input is SQLTextAreaShape => input.type === "sql-text-area"
            ),
          ];
          if (queries.some((query) => query.props.isRunning)) return { status: "waiting" };
          const execution = dag.plan.executionState;
          const sources = dag.plan.orderedDependencies.flatMap((dependency) => {
            if (dependency.type !== "data-source") return [];
            const source = getRemoteSourceMetadata(dependency);
            return source ? [{ sourceName: source.sourceName, sourceType: source.sourceType }] : [];
          });
          return {
            status: "ready",
            sources,
            payload: {
              sql: buildRemoteSQLFromDag(sql, dag.plan.orderedDependencies, editor),
              sourceName: execution.sourceName,
              sourceType: execution.sourceType,
              sourceNative: execution.sourceNativePreview,
              transient: true,
            },
            revision: `${editor.getCurrentPageId()}:${backendRevision.get()}:${queries.map((query) => `${query.id}:${runRevision(query.props.lastRunStats)}`).join(",")}`,
          };
        } catch (error) {
          return { status: "error", error: error instanceof Error ? error.message : String(error) };
        }
      };
      return JSON.stringify([JSON.stringify(build(sql)), cacheAlsoSQL ? JSON.stringify(build(cacheAlsoSQL)) : null]);
    },
    [editor, shape.id, shape.props.text, sql, error, cacheAlsoSQL]
  );
  const [requestKey, cacheAlsoKey] = useMemo(() => JSON.parse(requestKeys) as [string, string | null], [requestKeys]);
  const request = useMemo(() => JSON.parse(requestKey) as Request, [requestKey]);
  // Federated analysis requires automatic analysis to be enabled for every source.
  const autoRun = useSyncExternalStore(
    subscribeRemoteHoverPolicy,
    () =>
      request.status === "ready" &&
      request.sources.length > 0 &&
      request.sources.every((source) => getRemoteHoverPolicy(source.sourceName, source.sourceType) === "auto"),
    () => false
  );
  // Queries without a resolved source start manually; do not invent a persisted source preference.
  const [localAutoKey, setLocalAutoKey] = useState<string | null>(null);
  const auto = autoRun || (request.status === "ready" && !request.sources.length && localAutoKey === requestKey);
  useValue("Biz stats cache", () => cacheRevision.get(), []);
  // Keep visible results when older entries leave the shared cache.
  const visibleEntry = useRef<{ key: string; entry: CacheEntry } | null>(null);
  const cached =
    caches.get(editor)?.get(requestKey) ??
    (visibleEntry.current?.key === requestKey ? visibleEntry.current.entry : undefined);
  if (cached) visibleEntry.current = { key: requestKey, entry: cached };

  const start = () => {
    if (request.status !== "ready") return;
    let cache = caches.get(editor);
    if (!cache) {
      cache = new Map();
      caches.set(editor, cache);
    }
    if (cache.get(requestKey)?.state.status === "loading") return;
    const entry: CacheEntry = { state: { status: "loading" }, shapeId: createShapeId() };
    if (cache.size >= 100) {
      const oldest = [...cache].find(([, value]) => value.state.status !== "loading");
      if (oldest) cache.delete(oldest[0]);
    }
    cache.set(requestKey, entry);
    notifyCache();
    void runRemoteQuery({ ...request.payload, shapeId: entry.shapeId })
      .then((result) => {
        entry.state = { status: "ready", rows: result.sampleRows };
        // A condition breakdown also contains the total; update its card without another scan.
        if (cacheAlsoKey && cacheAlsoKey !== requestKey) cache.set(cacheAlsoKey, entry);
      })
      .catch((error) => {
        entry.state =
          entry.cancelled && (error?.name === "AbortError" || error?.message === "Query cancelled")
            ? { status: "idle" }
            : { status: "error", error: error instanceof Error ? error.message : String(error) };
      })
      .finally(notifyCache);
  };

  useEffect(() => {
    if (request.status !== "ready" || !auto || cached) return;
    // Avoid scans for intermediate SQL while typing, or a briefly mounted card.
    const timer = setTimeout(() => {
      if (!caches.get(editor)?.has(requestKey)) start();
    }, 300);
    return () => clearTimeout(timer);
  }, [editor, request, requestKey, runRemoteQuery, auto, cacheAlsoKey]);

  const state: StatsState =
    request.status !== "ready" ? request : (cached?.state ?? { status: auto ? "loading" : "idle" });
  const setAuto = (checked: boolean) => {
    if (request.status !== "ready") return;
    if (!request.sources.length) {
      setLocalAutoKey(checked ? requestKey : null);
      return;
    }
    for (const source of request.sources) {
      setRemoteHoverPolicy(source.sourceName, source.sourceType, checked ? "auto" : "ask");
    }
  };
  const stop = () => {
    if (cached?.state.status !== "loading") return;
    cached.cancelled = true;
    cancelRemoteQuery(cached.shapeId, `Biz analysis: ${shape.props.name}`);
  };
  return {
    state,
    retry: start,
    auto,
    setAuto,
    stop,
    canStop: cached?.state.status === "loading",
    canRun: request.status === "ready",
  };
}
