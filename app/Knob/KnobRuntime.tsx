import { useEffect, useRef } from "react";
import { useEditor, useValue, type TLShapeId } from "tldraw";
import { useData } from "../client/useLocalServer";
import { executeSQLShape } from "../SQLTextArea/executeSQLShape";
import type { SQLTextAreaShape } from "../SQLTextArea/sql-text-area-types";
import { getOrderedDependenciesForSQL } from "../SQLTextArea/sqlDependencies";
import { connectShapes, disconnectShapes } from "../util/shapeConnections";
import { getKnobNames, getSQLKnobs } from "./knobSQL";
import type { KnobShape } from "./knob-types";
import { ensureQueryKnobs } from "./createKnobs";
import { getKnobInferenceContext, inferKnob } from "./inferKnob";
import { isKnobQueryConnected } from "./knobUpstream";

// Mounted at canvas level: queries keep reacting even when their shapes are offscreen.
export function KnobRuntime() {
  const editor = useEditor();
  const data = useData();
  const dataRef = useRef(data);
  dataRef.current = data;
  const pageId = useValue("Knob page", () => editor.getCurrentPageId(), [editor]);
  const readonly = useValue("Knob runtime readonly", () => editor.getInstanceState().isReadonly, [editor]);

  useEffect(() => {
    if (readonly) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let knobsChanged = false;
    const signatures = new Map<TLShapeId, string>();
    const pending = new Set<TLShapeId>();
    const running = new Map<TLShapeId, AbortController>();
    const inferences = new Map<TLShapeId, { key: string; controller: AbortController }>();
    const inferred = new Map<TLShapeId, string>();
    const creationTimers = new Map<TLShapeId, ReturnType<typeof setTimeout>>();
    const scheduleCreation = (id: TLShapeId) => {
      clearTimeout(creationTimers.get(id));
      creationTimers.set(
        id,
        setTimeout(() => {
          creationTimers.delete(id);
          if (disposed || editor.isDisposed || editor.getInstanceState().isReadonly) return;
          const query = editor.getShape<SQLTextAreaShape>(id);
          if (query?.type === "sql-text-area") ensureQueryKnobs(editor, query, query.props.text);
          schedule();
        }, 1000)
      );
    };

    const inferOptions = (knobs: KnobShape[], queries: SQLTextAreaShape[]) => {
      for (const [id, request] of inferences) {
        if (
          !knobs.some((knob) => knob.id === id && knob.props.kind !== "text" && knob.props.inferFromColumn !== false)
        ) {
          request.controller.abort();
          inferences.delete(id);
        }
      }
      for (const knob of knobs) {
        if (knob.props.kind === "text" || knob.props.inferFromColumn === false) {
          inferred.delete(knob.id);
          continue;
        }
        const candidates = queries.filter((query) => isKnobQueryConnected(knob, query));
        candidates.sort(
          (a, b) => Number(b.id === knob.props.inferenceQueryId) - Number(a.id === knob.props.inferenceQueryId)
        );
        const context = getKnobInferenceContext(editor, knob, candidates);
        if (!context?.sql) {
          inferences.get(knob.id)?.controller.abort();
          inferences.delete(knob.id);
          inferred.delete(knob.id);
          if (knob.props.inferenceColumn) {
            const inferenceError = "The selected column is no longer available upstream.";
            if (knob.props.inferenceError !== inferenceError)
              editor.updateShape<KnobShape>({
                id: knob.id,
                type: "knob",
                props: { inferenceStatus: "error", inferenceError },
              });
          } else if (knob.props.inferenceStatus === "loading")
            editor.updateShape<KnobShape>({ id: knob.id, type: "knob", props: { inferenceStatus: "ready" } });
          continue;
        }
        const dependencies = getOrderedDependenciesForSQL(editor, context.sql).orderedDependencies;
        const key = JSON.stringify([
          context.query.id,
          context.sql,
          knob.props.inferenceColumn ? knob.props.kind : null,
          dependencies.map((dependency) => [
            dependency.id,
            dependency.type === "sql-text-area" ? dependency.props.text : dependency.props.remoteTableRef,
          ]),
        ]);
        if (inferences.get(knob.id)?.key === key || inferred.get(knob.id) === key) continue;
        inferences.get(knob.id)?.controller.abort();
        const controller = new AbortController();
        inferences.set(knob.id, { key, controller });
        editor.updateShape<KnobShape>({
          id: knob.id,
          type: "knob",
          props: { inferenceStatus: "loading", inferenceError: null },
        });
        void inferKnob(editor, dataRef.current, knob, context.sql, controller.signal)
          .then((props) => {
            const current = editor.getShape<KnobShape>(knob.id);
            if (disposed || controller.signal.aborted || !current || current.props.inferFromColumn === false) return;
            const query = editor.getShape<SQLTextAreaShape>(context.query.id);
            if (
              !query ||
              !isKnobQueryConnected(current, query) ||
              getKnobInferenceContext(editor, current, [query])?.sql !== context.sql
            )
              return;
            if (current.props.inferenceColumn && props.kind !== current.props.kind)
              throw new Error("This column no longer matches the knob's control type. Choose another column.");
            // Keep a user's selection if they adjusted the knob during inference.
            if ((props.kind === "numeric" || props.kind === "timestamp") && current.props.value !== knob.props.value) {
              props.value = Math.max(props.min!, Math.min(props.max!, current.props.value));
            }
            if (
              (props.kind === "category" || props.kind === "boolean") &&
              current.props.categoryValue !== knob.props.categoryValue &&
              props.options?.includes(current.props.categoryValue ?? "")
            ) {
              props.categoryValue = current.props.categoryValue;
            }
            inferred.set(knob.id, key);
            editor.updateShape<KnobShape>({
              id: knob.id,
              type: "knob",
              props: { ...props, inferenceStatus: "ready", inferenceError: null },
            });
          })
          .catch((error: unknown) => {
            const current = editor.getShape<KnobShape>(knob.id);
            if (disposed || controller.signal.aborted || !current || current.props.inferFromColumn === false) return;
            inferred.set(knob.id, key);
            editor.updateShape<KnobShape>({
              id: knob.id,
              type: "knob",
              props: {
                inferenceStatus: "error",
                inferenceError: error instanceof Error ? error.message : String(error),
              },
            });
          })
          .finally(() => {
            if (inferences.get(knob.id)?.controller === controller) inferences.delete(knob.id);
            schedule();
          });
      }
    };

    const schedule = () => {
      if (!disposed && timer === undefined) timer = setTimeout(flush, 80);
    };
    const reconcile = (rerun: boolean) => {
      const shapes = editor.getCurrentPageShapes();
      const knobs = shapes.filter((shape): shape is KnobShape => shape.type === "knob");
      const queries = shapes.filter((shape): shape is SQLTextAreaShape => shape.type === "sql-text-area");
      const queryIds = new Set(queries.map((query) => query.id));
      inferOptions(knobs, queries);
      for (const id of signatures.keys()) {
        if (!queryIds.has(id)) {
          signatures.delete(id);
          pending.delete(id);
          running.get(id)?.abort();
        }
      }
      for (const query of queries) {
        const directKnobs = getSQLKnobs(editor, query.props.text);
        const directIds = new Set(directKnobs.map((knob) => knob.id));
        editor.run(
          () => {
            for (const knob of knobs) {
              const connected =
                query.props.upstreamShapeIds?.includes(knob.id) || knob.props.downstreamShapeIds?.includes(query.id);
              if (connected && !directIds.has(knob.id)) disconnectShapes(editor, knob.id, query.id);
              if (directIds.has(knob.id) && !connected) connectShapes(editor, knob.id, query.id);
            }
          },
          { history: "ignore" }
        );
        const { orderedDependencies } = getOrderedDependenciesForSQL(editor, query.props.text);
        const names = [
          ...new Set(
            [query, ...orderedDependencies].flatMap((dependency) =>
              dependency.type === "sql-text-area" ? getKnobNames(dependency.props.text) : []
            )
          ),
        ].sort();
        const signature = JSON.stringify(
          names.map((name) => [
            name,
            knobs
              .filter((knob) => knob.props.name.toUpperCase() === name)
              .map((knob) => [
                knob.id,
                knob.props.kind ?? "numeric",
                knob.props.categoryType,
                knob.props.temporalType,
                knob.props.kind === "category" || knob.props.kind === "boolean" || knob.props.kind === "text"
                  ? knob.props.categoryValue
                  : knob.props.value,
              ]),
          ])
        );
        const previous = signatures.get(query.id);
        signatures.set(query.id, signature);
        if (rerun && previous !== undefined && previous !== signature) {
          pending.add(query.id);
        }
      }
    };
    function flush() {
      timer = undefined;
      if (disposed || editor.isDisposed) return;
      const rerun = knobsChanged;
      knobsChanged = false;
      reconcile(rerun);
      for (const id of pending) {
        const query = editor.getShape<SQLTextAreaShape>(id);
        if (!query || query.type !== "sql-text-area") {
          pending.delete(id);
          continue;
        }
        // Finish the current run, then execute only the latest slider value.
        if (query.props.isRunning || running.has(id)) continue;
        const dependencies = getOrderedDependenciesForSQL(editor, query.props.text).orderedDependencies;
        if (creationTimers.has(id) || dependencies.some((dependency) => creationTimers.has(dependency.id))) continue;
        if (
          [query, ...dependencies].some(
            (dependency) =>
              dependency.type === "sql-text-area" &&
              getSQLKnobs(editor, dependency.props.text).some((knob) => knob.props.inferenceStatus === "loading")
          )
        )
          continue;
        pending.delete(id);
        const controller = new AbortController();
        running.set(id, controller);
        void executeSQLShape(editor, dataRef.current, id, query.props.text, controller.signal, {
          createMissingKnobs: false,
        })
          .catch((error: unknown) => {
            if (disposed || controller.signal.aborted || !editor.getShape(id)) return;
            editor.updateShape<SQLTextAreaShape>({
              id,
              type: "sql-text-area",
              props: {
                error: error instanceof Error ? error.message : String(error),
                isDirty: true,
              },
            });
          })
          .finally(() => {
            running.delete(id);
            if (pending.size) schedule();
          });
      }
      if (pending.size) schedule();
    }

    reconcile(false);
    const unlisten = editor.store.listen(
      ({ changes }) => {
        let relevant = false;
        for (const record of [...Object.values(changes.added), ...Object.values(changes.removed)]) {
          if (record.typeName !== "shape") continue;
          if (record.type === "knob") {
            knobsChanged = true;
            relevant = true;
          }
          if (record.type === "sql-text-area") {
            if (editor.getShape(record.id)) scheduleCreation(record.id);
            else {
              clearTimeout(creationTimers.get(record.id));
              creationTimers.delete(record.id);
            }
            relevant = true;
          }
          if (record.type === "data-source") relevant = true;
        }
        for (const [before, after] of Object.values(changes.updated)) {
          if (before.typeName !== "shape" || after.typeName !== "shape") continue;
          if (before.type === "knob" && after.type === "knob") {
            const a = before as KnobShape;
            const b = after as KnobShape;
            if (
              a.props.name !== b.props.name ||
              a.props.value !== b.props.value ||
              a.props.kind !== b.props.kind ||
              a.props.categoryValue !== b.props.categoryValue ||
              a.props.categoryType !== b.props.categoryType ||
              a.props.temporalType !== b.props.temporalType
            ) {
              knobsChanged = true;
              relevant = true;
            }
            if (
              a.props.inferFromColumn !== b.props.inferFromColumn ||
              a.props.inferenceColumn !== b.props.inferenceColumn ||
              a.props.inferenceQueryId !== b.props.inferenceQueryId ||
              a.props.inferenceSourceId !== b.props.inferenceSourceId
            )
              relevant = true;
          }
          if (before.type === "sql-text-area" && after.type === "sql-text-area") {
            const a = before as SQLTextAreaShape;
            const b = after as SQLTextAreaShape;
            if (a.props.text !== b.props.text) {
              scheduleCreation(b.id);
              relevant = true;
            }
            if (!a.props.isRunning && b.props.isRunning) {
              clearTimeout(creationTimers.get(b.id));
              creationTimers.delete(b.id);
            }
            if (a.props.name !== b.props.name || a.props.upstreamShapeIds !== b.props.upstreamShapeIds) relevant = true;
          }
          if (after.type === "data-source") relevant = true;
        }
        if (relevant) schedule();
      },
      { scope: "document" }
    );
    const refreshInference = (event: Event) => {
      const id = (event as CustomEvent<{ shapeId?: TLShapeId }>).detail?.shapeId;
      for (const [knobId, request] of inferences) {
        if (!id || id === knobId) {
          request.controller.abort();
          inferences.delete(knobId);
        }
      }
      if (id) inferred.delete(id);
      else inferred.clear();
      schedule();
    };
    window.addEventListener("kavla:infer-knob", refreshInference);
    window.addEventListener("kavla:uploads-changed", refreshInference);
    window.addEventListener("kavla:backend-reset", refreshInference);
    return () => {
      disposed = true;
      clearTimeout(timer);
      for (const creationTimer of creationTimers.values()) clearTimeout(creationTimer);
      unlisten();
      window.removeEventListener("kavla:infer-knob", refreshInference);
      window.removeEventListener("kavla:uploads-changed", refreshInference);
      window.removeEventListener("kavla:backend-reset", refreshInference);
      for (const controller of running.values()) controller.abort();
      for (const request of inferences.values()) request.controller.abort();
    };
  }, [editor, pageId, readonly]);
  return null;
}
