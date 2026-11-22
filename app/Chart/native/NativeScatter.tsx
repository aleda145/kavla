import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HTMLContainer, createShapeId, useValue, type Editor, type TLDrawShape, type TLShapeId } from "tldraw";
import { Priority } from "@uwdata/mosaic-core";
import type { ChartShape } from "../chart-shape-types";
import type { SQLTextAreaShape } from "../../SQLTextArea/sql-text-area-types";
import { useData } from "../../client/useLocalServer";
import { executeSQLShape } from "../../SQLTextArea/executeSQLShape";
import { getUniqueName } from "../../util/getUniqueName";
import { connectShapes } from "../../util/shapeConnections";
import { chartGeometry, drawingToPlotPoints } from "./geometry";
import { domain, planScatter, pointBudget, statisticsSQL, type ScatterPlan } from "./planner";
import {
  coordinateSQL,
  identifier,
  selectionSQL,
  validatePolygon,
  type Axis,
  type ScatterSelection,
} from "./selection";
import { scatterSource } from "./source";
import { ScatterMarks, type Mark } from "./ScatterMarks";
import { ScatterAxes } from "./ScatterAxes";
import { useVisualizationSession } from "./VisualizationProvider";

const headerHeight = 42;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const buttonStyle = {
  border: "2px solid black",
  borderRadius: 4,
  background: "#fff",
  padding: "3px 7px",
  fontWeight: 700,
  cursor: "pointer",
} as const;
type Loaded = { revision: string; x: Axis; y: Axis; marks: Mark[]; plan: ScatterPlan; total: number; valid: number };

function readSelection(value: unknown): ScatterSelection | null {
  if (typeof value !== "string") return null;
  const s = JSON.parse(value) as ScatterSelection;
  if (
    s.version !== 1 ||
    s.semantics !== "observations" ||
    s.policy !== "live" ||
    typeof s.sourceRevision !== "string" ||
    typeof s.sourceSQL !== "string" ||
    typeof s.sourceId !== "string" ||
    typeof s.drawingId !== "string" ||
    typeof s.chartId !== "string" ||
    ![s.x, s.y].every(
      (axis) =>
        axis &&
        typeof axis.field === "string" &&
        ["linear", "log"].includes(axis.type) &&
        Array.isArray(axis.domain) &&
        axis.domain.length === 2 &&
        axis.domain.every((n) => Number.isFinite(n) && (axis.type !== "log" || n > 0)) &&
        axis.domain[0] !== axis.domain[1]
    ) ||
    !Array.isArray(s.polygon)
  )
    throw new Error("This saved selection is not supported.");
  s.polygon = validatePolygon(s.polygon);
  coordinateSQL(s.x);
  coordinateSQL(s.y);
  return s;
}

export function NativeScatter({ editor, shape }: { editor: Editor; shape: ChartShape }) {
  const { coordinator } = useVisualizationSession();
  const data = useData();
  const visible = useValue("native scatter visible", () => !editor.getCulledShapes().has(shape.id), [editor, shape.id]);
  const sourceState = useValue(
    "native scatter source",
    () => {
      try {
        return JSON.stringify({ source: scatterSource(editor, shape) });
      } catch (error) {
        return JSON.stringify({ error: message(error) });
      }
    },
    [editor, shape.props.sourceShapeId]
  );
  const sourceInfo = useMemo(
    () => JSON.parse(sourceState) as { source?: ReturnType<typeof scatterSource>; error?: string },
    [sourceState]
  );
  const source = sourceInfo.source;
  const controlsHeight = shape.props.w < 500 ? 126 : 82;
  const width = Math.max(150, shape.props.w - 8),
    height = Math.max(100, shape.props.h - headerHeight - controlsHeight - 8);
  const xLog = shape.meta.nativeXLog === true,
    yLog = shape.meta.nativeYLog === true;
  const [size, setSize] = useState({ width, height });
  useEffect(() => {
    const timer = setTimeout(() => setSize({ width, height }), 150);
    return () => clearTimeout(timer);
  }, [width, height]);
  const [refresh, setRefresh] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [exploring, setExploring] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const saved = useMemo(() => {
    try {
      return { selection: readSelection(shape.meta.nativeSelection), error: null };
    } catch (error) {
      return { selection: null, error: message(error) };
    }
  }, [shape.meta.nativeSelection]);
  const selection = saved.selection;
  const setMeta = useCallback(
    (patch: Record<string, string | boolean | null>) => {
      const current = editor.getShape(shape.id);
      if (current) editor.updateShape({ id: shape.id, type: "chart-shape", meta: { ...current.meta, ...patch } });
    },
    [editor, shape.id]
  );
  const requestKey = JSON.stringify([source?.revision, shape.props.x, shape.props.y, xLog, yLog, refresh]);

  useEffect(() => {
    setError(null);
    if (!visible) {
      setBusy(false);
      return;
    }
    if (!source || !shape.props.x || !shape.props.y) {
      setLoaded(null);
      return;
    }
    const xField = shape.props.x,
      yField = shape.props.y;
    if (
      [xField, yField].some(
        (field) =>
          !source.schema.some(
            (c) =>
              c.name === field &&
              /^(U?INT|U?BIGINT|HUGEINT|SMALLINT|TINYINT|FLOAT|DOUBLE|REAL|DECIMAL|NUMERIC)/i.test(c.type)
          )
      )
    ) {
      setLoaded(null);
      setError("The prototype requires two numeric columns. Choose them in ECharts, then reopen the prototype.");
      return;
    }
    let current = true;
    const requests: ReturnType<typeof coordinator.query>[] = [];
    // The revision is part of SQL because Mosaic 0.33 keys its cache by SQL.
    const stamp = `/* kavla-view ${encodeURIComponent(requestKey)} */\n`;
    const query = (sql: string) => {
      const request = coordinator.query(stamp + sql);
      requests.push(request);
      return request;
    };
    setBusy(true);
    void (async () => {
      const stats = (await query(statisticsSQL(source.sql, xField, yField, xLog, yLog))).toArray()[0];
      if (!current) return;
      const valid = Number(stats.valid);
      if (!valid) throw new Error("No finite observations for these axes.");
      const x: Axis = {
        field: xField,
        type: xLog ? "log" : "linear",
        domain: domain(Number(stats.xmin), Number(stats.xmax), xLog),
      };
      const y: Axis = {
        field: yField,
        type: yLog ? "log" : "linear",
        domain: domain(Number(stats.ymin), Number(stats.ymax), yLog),
      };
      const plan = planScatter(source.sql, x, y, valid, size.width - 90, size.height - 64);
      const result = await query(plan.sql);
      if (!current) return;
      if (plan.mode === "points" && result.numRows > pointBudget)
        throw new Error("The source grew while plotting. Refresh to recompute density; no partial plot is shown.");
      setLoaded({
        revision: requestKey,
        x,
        y,
        plan,
        total: Number(stats.total),
        valid,
        marks: result.toArray().map((row) => ({ x: Number(row.x), y: Number(row.y), count: Number(row.count) })),
      });
    })()
      .catch((error) => {
        if (current) {
          setError(message(error));
          setLoaded(null);
        }
      })
      .finally(() => {
        if (current) setBusy(false);
      });
    return () => {
      current = false;
      coordinator.cancel(requests);
    };
  }, [coordinator, requestKey, size.width, size.height, sourceState, visible]);

  const currentPlot = loaded?.revision === requestKey ? loaded : null;
  const geometry = useMemo(
    () => (currentPlot ? chartGeometry(width, height, currentPlot.x, currentPlot.y) : null),
    [width, height, currentPlot]
  );
  const selectionCurrent = Boolean(
    selection &&
    source &&
    currentPlot &&
    selection.sourceId === source.id &&
    selection.sourceRevision === source.revision &&
    selection.x.field === currentPlot.x.field &&
    selection.y.field === currentPlot.y.field &&
    selection.x.type === currentPlot.x.type &&
    selection.y.type === currentPlot.y.type
  );
  // Selection is defined in its original domain. Project it into refreshed
  // domains for feedback; do not reinterpret it after a move/resize/refresh.
  const visiblePolygon = useMemo(() => {
    if (!selectionCurrent || !selection || !geometry) return null;
    const original = chartGeometry(width, height, selection.x, selection.y);
    return selection.polygon.map((p) => geometry.normalize(original.unproject(original.fromAnalytical(p))));
  }, [selectionCurrent, selection, geometry, width, height]);

  const acceptDrawing = useCallback(
    (drawing: TLDrawShape, explicit = false) => {
      if (!geometry || !source || !currentPlot) {
        if (explicit) setSelectionError("Wait for a current plot before selecting.");
        return;
      }
      const transform = editor.getShapePageTransform(drawing);
      const rawPoints = drawing.props.segments.flatMap((segment) => segment.points);
      if (!rawPoints.length) return;
      if (
        !explicit &&
        editor.getShapeAtPoint(transform.applyToPoint(rawPoints[0]), {
          hitInside: true,
          filter: (candidate) => candidate.type === "chart-shape",
        })?.id !== shape.id
      )
        return;
      const points = drawingToPlotPoints(
        rawPoints,
        (p) => transform.applyToPoint(p),
        (p) => editor.getPointInShapeSpace(shape.id, p),
        { x: 4, y: 4 + headerHeight }
      );
      if (!points.length) return;
      const first = geometry.toAnalytical(points[0]);
      if (!explicit && (first.x < 0 || first.x > 1 || first.y < 0 || first.y > 1)) return;
      try {
        if (!drawing.props.isComplete) throw new Error("Finish the drawing before selecting.");
        const end = points.at(-1)!;
        if (!drawing.props.isClosed && Math.hypot(end.x - points[0].x, end.y - points[0].y) > 12)
          throw new Error("Close the freehand outline (end within 12 chart pixels of the start), then retry.");
        const polygon = validatePolygon(points.map(geometry.toAnalytical));
        const next: ScatterSelection = {
          version: 1,
          semantics: "observations",
          policy: "live",
          sourceId: source.id,
          sourceRevision: source.revision,
          sourceSQL: source.sql,
          chartId: shape.id,
          drawingId: drawing.id,
          x: currentPlot.x,
          y: currentPlot.y,
          polygon,
        };
        setCount(null);
        setSelectionError(null);
        setMeta({ nativeSelection: JSON.stringify(next), nativeLassoError: null, nativeLassoDrawing: drawing.id });
      } catch (error) {
        setCount(null);
        setSelectionError(message(error));
        setMeta({ nativeSelection: null, nativeLassoDrawing: drawing.id, nativeLassoError: message(error) });
      }
    },
    [editor, shape.id, geometry, source, currentPlot, setMeta]
  );

  useEffect(
    () =>
      editor.sideEffects.registerAfterChangeHandler("shape", (before, after) => {
        if (
          before.type === "draw" &&
          after.type === "draw" &&
          !(before as TLDrawShape).props.isComplete &&
          (after as TLDrawShape).props.isComplete
        )
          queueMicrotask(() => acceptDrawing(after as TLDrawShape));
      }),
    [editor, acceptDrawing]
  );

  useEffect(() => {
    setCount(null);
    if (!selectionCurrent || !selection || !visible) return;
    const controller = new AbortController();
    let current = true;
    // Authoritative counts are always live and never use the result cache.
    const request = coordinator.query(
      `SELECT count(*) AS count FROM (${selectionSQL(selection.sourceSQL, selection)})`,
      { cache: false, priority: Priority.High, signal: controller.signal }
    );
    void request.then(
      (table) => {
        if (current) {
          setCount(Number(table.toArray()[0].count));
          setSelectionError(null);
        }
      },
      (error) => {
        if (current) setSelectionError(message(error));
      }
    );
    return () => {
      current = false;
      controller.abort();
      coordinator.cancel([request]);
    };
  }, [coordinator, selection, selectionCurrent, refresh, visible]);

  const branchController = useRef<AbortController | null>(null);
  useEffect(() => () => branchController.current?.abort(), []);
  const explore = async () => {
    if (!selection || !source || count === null || !selectionCurrent) return;
    setExploring(true);
    try {
      const latest = scatterSource(editor, shape);
      if (latest.revision !== selection.sourceRevision)
        throw new Error("The upstream query changed. Draw a new selection.");
      const text = selectionSQL(`SELECT * FROM ${identifier(latest.name)}`, selection);
      const id = createShapeId();
      const bounds = editor.getShapePageBounds(shape.id)!;
      editor.createShape<SQLTextAreaShape>({
        id,
        type: "sql-text-area",
        x: bounds.maxX + 60,
        y: bounds.y,
        props: { name: getUniqueName(editor, `${latest.name}_selected`), text, isDirty: true, showTable: true },
        meta: { nativeSelection: JSON.stringify(selection) },
      });
      connectShapes(editor, latest.id, id);
      const controller = new AbortController();
      branchController.current = controller;
      const result = await executeSQLShape(editor, data, id, text, controller.signal, { createMissingKnobs: false });
      if (!result.success) throw new Error(result.error ?? "The selected query failed. Retry from the new SQL shape.");
      try {
        if (scatterSource(editor, shape).revision !== selection.sourceRevision)
          throw new Error("The upstream query changed while the branch ran. Run this SQL shape again.");
      } catch (error) {
        editor.updateShape<SQLTextAreaShape>({
          id,
          type: "sql-text-area",
          props: { isDirty: true, error: message(error) },
        });
        throw error;
      }
      editor.select(id);
    } catch (error) {
      setSelectionError(message(error));
    } finally {
      setExploring(false);
    }
  };

  const errorText =
    sourceInfo.error ||
    error ||
    saved.error ||
    selectionError ||
    (typeof shape.meta.nativeLassoError === "string" ? shape.meta.nativeLassoError : null);
  const renderer =
    shape.meta.nativeRenderer === "svg"
      ? "svg"
      : shape.meta.nativeRenderer === "canvas"
        ? "canvas"
        : (currentPlot?.marks.length ?? 0) < 1000
          ? "svg"
          : "canvas";
  return (
    <HTMLContainer
      id={shape.id}
      style={{
        width: shape.props.w,
        height: shape.props.h,
        border: "4px solid black",
        borderRadius: 12,
        background: "white",
        boxSizing: "border-box",
        fontFamily: "Inter, sans-serif",
        pointerEvents: "all",
      }}
    >
      <div
        style={{
          height: headerHeight,
          boxSizing: "border-box",
          borderBottom: "4px solid black",
          background: "#fce7f3",
          borderRadius: "8px 8px 0 0",
          padding: "5px 8px",
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12,
        }}
      >
        <strong style={{ flex: 1 }}>SCATTER · NATIVE PROTOTYPE</strong>
        <button
          style={buttonStyle}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setMeta({ nativeVisualization: false })}
        >
          ECharts
        </button>
      </div>
      <div style={{ position: "relative", width, height, overflow: "hidden" }}>
        {geometry && currentPlot && (
          <>
            <ScatterMarks
              marks={currentPlot.marks}
              geometry={geometry}
              plan={currentPlot.plan}
              polygon={visiblePolygon}
              width={width}
              height={height}
              renderer={renderer}
            />
            <ScatterAxes
              geometry={geometry}
              width={width}
              height={height}
              xLabel={currentPlot.x.field}
              yLabel={currentPlot.y.field}
              polygon={visiblePolygon}
            />
          </>
        )}
        {(!currentPlot || errorText) && (
          <div
            role="status"
            style={{
              position: "absolute",
              inset: 10,
              background: "#fffef0",
              padding: 10,
              fontSize: 12,
              height: "fit-content",
              pointerEvents: "none",
            }}
          >
            {errorText || "Loading plot through Mosaic…"}
          </div>
        )}
      </div>
      <div
        style={{
          height: controlsHeight,
          boxSizing: "border-box",
          borderTop: "2px solid black",
          padding: 5,
          fontSize: 10,
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          <button style={buttonStyle} onClick={() => editor.setCurrentTool("draw")}>
            Draw lasso
          </button>
          <button
            style={buttonStyle}
            onClick={() => {
              const drawing =
                editor.getSelectedShapes().find((s) => s.type === "draw") ??
                editor.getShape(shape.meta.nativeLassoDrawing as TLShapeId);
              if (drawing?.type === "draw") acceptDrawing(drawing as TLDrawShape, true);
              else setSelectionError("Select a freehand drawing, then retry.");
            }}
          >
            Use drawing / retry
          </button>
          <button
            style={buttonStyle}
            disabled={count === null || !selectionCurrent || exploring}
            onClick={() => void explore()}
          >
            {exploring ? "Running…" : "Explore selected data"}
          </button>
          <button
            style={buttonStyle}
            onClick={() => {
              setSelectionError(null);
              setRefresh((n) => n + 1);
            }}
          >
            Refresh
          </button>
          <label>
            <input type="checkbox" checked={xLog} onChange={(e) => setMeta({ nativeXLog: e.target.checked })} />
            Log X
          </label>
          <label>
            <input type="checkbox" checked={yLog} onChange={(e) => setMeta({ nativeYLog: e.target.checked })} />
            Log Y
          </label>
          <select
            aria-label="Native renderer"
            value={(shape.meta.nativeRenderer as string) ?? "auto"}
            onChange={(e) => setMeta({ nativeRenderer: e.target.value })}
          >
            <option value="auto">Auto</option>
            <option value="svg">SVG</option>
            <option value="canvas">Canvas</option>
          </select>
        </div>
        <span>
          {currentPlot
            ? `${currentPlot.total.toLocaleString()} source rows · ${currentPlot.marks.length.toLocaleString()} ${currentPlot.plan.mode === "density" ? "density bins (reduced; highlighted bin centers are a preview)" : "points"} · ${currentPlot.total - currentPlot.valid} invalid/log-ineligible rows excluded`
            : ""}
          {busy ? " · Updating…" : ""}
          {shape.props.color ? " · Color grouping is not applied in this prototype." : ""}
        </span>
        <strong>
          {selection
            ? selectionCurrent
              ? count === null
                ? "Evaluating exact live selection…"
                : `${count.toLocaleString()} observations selected · live predicate, including duplicate coordinates`
              : "The source or axes changed. Draw a new selection."
            : "Draw a closed outline over the plot. Self intersections use even-odd fill."}
        </strong>
      </div>
    </HTMLContainer>
  );
}
