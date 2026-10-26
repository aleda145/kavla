import { useEffect, useMemo, useState } from "react";
import { createShapeId, useEditor, useValue, type Editor } from "tldraw";
import { backendRevision } from "../client/backendCompute";
import { useData } from "../client/useLocalServer";
import { buildRemoteSQLFromDag, walkSQLDag } from "./walkSQLDag";
import { readBizFilterCounts, type BizFilterCounts, type BizFilterPlan } from "./sqlBizFilterStats";
import type { SQLTextAreaShape } from "./sql-text-area-types";
import type { RunRemoteQueryPayload } from "../client/localServer/types";

type CountsState =
  { status: "loading" | "waiting" } | { status: "error"; error: string } | { status: "ready"; counts: BizFilterCounts };
type Request =
  | { status: "waiting" }
  | { status: "error"; error: string }
  | { status: "ready"; payload: Omit<RunRemoteQueryPayload, "shapeId">; revision: string; conditionCount: number };

const caches = new WeakMap<Editor, Map<string, Promise<CountsState>>>();
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
  const editor = useEditor();
  const { runRemoteQuery } = useData();
  const requestKey = useValue(
    "Biz filter counts input",
    () => {
      const build = (): Request => {
        if ("error" in plan) return { status: "error", error: plan.error };
        try {
          const current = editor.getShape<SQLTextAreaShape>(shape.id);
          if (!current || current.props.text !== shape.props.text) return { status: "waiting" };
          const sql = perCondition ? plan.conditionsSQL : plan.totalSQL;
          const dag = walkSQLDag(editor, sql);
          if (!dag.ok) throw new Error(dag.error.message);
          if (dag.plan.orderedDependencies.some((input) => input.id === shape.id)) {
            throw new Error("Cannot count this filter because its source resolves back to the current query.");
          }
          const queries = [
            current,
            ...dag.plan.orderedDependencies.filter(
              (input): input is SQLTextAreaShape => input.type === "sql-text-area"
            ),
          ];
          if (queries.some((query) => query.props.isRunning)) return { status: "waiting" };
          const execution = dag.plan.executionState;
          return {
            status: "ready",
            payload: {
              sql: buildRemoteSQLFromDag(sql, dag.plan.orderedDependencies, editor),
              sourceName: execution.sourceName,
              sourceType: execution.sourceType,
              sourceNative: execution.sourceNativePreview,
              transient: true,
            },
            revision: `${editor.getCurrentPageId()}:${backendRevision.get()}:${queries.map((query) => `${query.id}:${runRevision(query.props.lastRunStats)}`).join(",")}`,
            conditionCount: perCondition ? plan.conditions.length : 0,
          };
        } catch (error) {
          return { status: "error", error: error instanceof Error ? error.message : String(error) };
        }
      };
      return JSON.stringify(build());
    },
    [editor, shape.id, shape.props.text, plan, perCondition]
  );
  const request = useMemo(() => JSON.parse(requestKey) as Request, [requestKey]);
  const [result, setResult] = useState<{ key: string; state: CountsState } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (request.status !== "ready") return;
    let active = true;
    // Avoid scans for intermediate SQL while typing, or a briefly mounted card.
    const timer = setTimeout(() => {
      let cache = caches.get(editor);
      if (!cache) {
        cache = new Map();
        caches.set(editor, cache);
      }
      let pending = cache.get(requestKey);
      if (!pending) {
        pending = runRemoteQuery({ ...request.payload, shapeId: createShapeId() })
          .then((result): CountsState => {
            if (result.sampleRows.length !== 1) throw new Error("Expected one row of filter counts.");
            return { status: "ready", counts: readBizFilterCounts(result.sampleRows[0], request.conditionCount) };
          })
          .catch((error): CountsState => ({
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          }));
        if (cache.size >= 100) cache.delete(cache.keys().next().value!);
        cache.set(requestKey, pending);
      }
      void pending.then((state) => {
        if (active) setResult({ key: requestKey, state });
      });
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [editor, request, requestKey, runRemoteQuery, attempt]);

  const state: CountsState =
    request.status !== "ready" ? request : result?.key === requestKey ? result.state : { status: "loading" };
  const retry = () => {
    caches.get(editor)?.delete(requestKey);
    setResult(null);
    setAttempt((value) => value + 1);
  };
  return { state, retry };
}
