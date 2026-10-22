import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  HTMLContainer,
  createShapeId,
  getDefaultColorTheme,
  STROKE_SIZES,
  useValue,
  type Editor,
  type TLDrawShape,
  type TLShapeId,
} from "tldraw";
import {
  ArrowUpRight,
  CircleAlert,
  Lasso,
  RefreshCw,
  ScatterChart,
  Settings2,
  X,
  ChevronLeft,
  ChevronRight,
  LineChart,
  BarChart3,
  AreaChart,
} from "lucide-react";
import { densityScale, densityOpacity, groupColor } from "./appearance";
import "./native-scatter.css";
import { Priority } from "@uwdata/mosaic-core";
import type { ChartShape } from "../chart-shape-types";
import type { SQLTextAreaShape } from "../../SQLTextArea/sql-text-area-types";
import { useData } from "../../client/useLocalServer";
import { executeSQLShape } from "../../SQLTextArea/executeSQLShape";
import { getUniqueName } from "../../util/getUniqueName";
import { getColumnTypeColor } from "../../util/column-colors";
import { connectShapes } from "../../util/shapeConnections";
import { chartGeometry, drawingToPlotPoints } from "./geometry";
import {
  loadChartData,
  isNumericColumn,
  xKindFor,
  type ChartData,
  type ChartKind,
  type ChartQuery,
} from "./chart-data";
import { SeriesMarks } from "./SeriesMarks";
import { restoreRemoteQueryView } from "../../SQLTextArea/restoreRemoteQueryView";
import { exportNativeChart } from "./export-chart";
import { readSelection, selectionSQL, validatePolygon, type ScatterSelection } from "./selection";
import { selectedAreaPreview } from "../../SQLTextArea/selected-area-navigation";
import { scatterSource } from "./source";
import { ScatterMarks } from "./ScatterMarks";
import { ScatterAxes } from "./ScatterAxes";
import { ScatterTooltip } from "./ScatterTooltip";
import { useVisualizationSession } from "./VisualizationProvider";

const headerHeight = 42;
const axisBarHeight = 64;
const actionBarWidth = 48;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
type Loaded = ChartData & { revision: string };

export function NativeChart({ editor, shape }: { editor: Editor; shape: ChartShape }) {
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
    [editor, shape.props.sourceShapeId, shape.props.limit]
  );
  const sourceInfo = useMemo(
    () => JSON.parse(sourceState) as { source?: ReturnType<typeof scatterSource>; error?: string },
    [sourceState]
  );
  const source = sourceInfo.source;
  const compact = shape.props.w < 280 || shape.props.h < 260;
  const [pageOffset, setPageOffset] = useState(0);
  const kind = (shape.props.chartType ?? "scatter") as ChartKind;
  const xKind = xKindFor(
    shape.props.x ?? "",
    source?.schema.find((column) => column.name === shape.props.x)?.type ?? "",
    kind
  );
  const stacked = Boolean(shape.props.color && shape.props.isStacked && (kind === "bar" || kind === "area"));
  const canSelect = kind === "scatter" && xKind === "number" && Boolean(source?.canSelect);
  const saved = useMemo(() => {
    try {
      return { selection: readSelection(shape.meta.nativeSelection), error: null };
    } catch (error) {
      return { selection: null, error: message(error) };
    }
  }, [shape.meta.nativeSelection]);
  const selection = saved.selection;
  const preview = useValue(
    "linked selected area",
    () => {
      const area = selectedAreaPreview(editor).get();
      return area?.chartId === shape.id && editor.getSelectedShapeIds().includes(shape.id) ? area : null;
    },
    [editor, shape.id]
  );
  const pendingDrawings = useRef(new Set<TLShapeId>());
  const currentTool = useValue("chart outline tool", () => editor.getCurrentToolId(), [editor]);
  const capturing = currentTool === "draw" && canSelect;
  const controlsHeight = compact
    ? 0
    : 28 + (shape.props.color ? 24 : 0) + (preview || (selection && canSelect) ? 34 : 0);
  const [exporting, setExporting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsId = useId();
  const settingsRef = useRef<HTMLDivElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const zoomLevel = useValue("native scatter zoom", () => editor.getZoomLevel(), [editor]);
  useEffect(() => {
    if (!settingsOpen) return;
    settingsRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!settingsRef.current?.contains(target) && !settingsButton.current?.contains(target)) setSettingsOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setSettingsOpen(false);
        settingsButton.current?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", escape, true);
    };
  }, [settingsOpen]);
  const width = Math.max(1, shape.props.w - actionBarWidth - 8),
    height = Math.max(1, shape.props.h - headerHeight - controlsHeight - axisBarHeight - 8);
  const xLog = shape.meta.nativeXLog === true && xKind === "number",
    yLog = shape.meta.nativeYLog === true && !stacked && kind !== "bar";
  const [size, setSize] = useState({ width, height });
  const [pixelRatio, setPixelRatio] = useState(zoomLevel);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSize({ width, height });
      setPixelRatio(zoomLevel);
    }, 150);
    return () => clearTimeout(timer);
  }, [width, height, zoomLevel]);
  const [refresh, setRefresh] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [exploring, setExploring] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const setMeta = useCallback(
    (patch: Record<string, string | boolean | null>) => {
      const current = editor.getShape(shape.id);
      if (current) editor.updateShape({ id: shape.id, type: "chart-shape", meta: { ...current.meta, ...patch } });
    },
    [editor, shape.id]
  );
  const requestKey = JSON.stringify([
    source?.revision,
    shape.props.x,
    shape.props.y,
    shape.props.color,
    kind,
    shape.props.isStacked,
    shape.props.yAxisScale,
    shape.props.limit,
    xLog,
    yLog,
    refresh,
    pageOffset,
  ]);
  useEffect(() => setPageOffset(0), [shape.props.x, shape.props.y, shape.props.color, kind, shape.props.limit]);

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
    let current = true;
    const requests: ReturnType<typeof coordinator.query>[] = [];
    // The revision is part of SQL because Mosaic 0.33 keys its cache by SQL.
    const stamp = `/* kavla-view ${encodeURIComponent(JSON.stringify([source.revision, refresh]))} */\n`;
    const query: ChartQuery = (sql) => {
      if (!current) throw new DOMException("Chart query was cancelled.", "AbortError");
      const request = coordinator.query(sql);
      requests.push(request);
      return request;
    };
    setBusy(true);
    void (async () => {
      const load = () =>
        loadChartData(query, { ...source, sql: stamp + source.sql }, shape.props, {
          xLog,
          yLog,
          width: size.width - 90,
          height: size.height - 64,
          offset: pageOffset,
        });
      let result: ChartData;
      try {
        result = await load();
      } catch (error) {
        if (!current) return;
        if (!/_kavla_result_[a-f0-9]+.*does not exist/is.test(message(error))) throw error;
        const sourceShape = editor.getShape<SQLTextAreaShape>(source.id);
        if (!sourceShape) throw error;
        await restoreRemoteQueryView(editor, sourceShape, data.runRemoteQuery);
        if (!current) return;
        result = await load();
      }
      if (current) setLoaded({ ...result, revision: requestKey });
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
    canSelect &&
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
    if (
      preview &&
      geometry &&
      currentPlot &&
      preview.x.field === currentPlot.x.field &&
      preview.y.field === currentPlot.y.field &&
      currentPlot.xKind === "number"
    ) {
      const original = chartGeometry(width, height, preview.x, preview.y);
      return preview.polygon.map((p) => geometry.normalize(original.unproject(original.fromAnalytical(p))));
    }
    if (!selectionCurrent || !selection || !geometry) return null;
    const original = chartGeometry(width, height, selection.x, selection.y);
    return selection.polygon.map((p) => geometry.normalize(original.unproject(original.fromAnalytical(p))));
  }, [selectionCurrent, selection, geometry, width, height, preview, currentPlot]);

  const acceptDrawing = useCallback(
    (drawing: TLDrawShape, explicit = false) => {
      if (!editor.getShape(drawing.id) || !editor.getShape(shape.id)) return;
      if (!canSelect || !geometry || !source || !currentPlot) {
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
        if (
          editor.getIsReadonly() ||
          editor.isShapeOrAncestorLocked(shape.id) ||
          editor.isShapeOrAncestorLocked(drawing.id)
        )
          throw new Error("Unlock the chart and drawing before attaching an outline.");
        if (!drawing.props.isComplete) throw new Error("Finish the drawing before selecting.");
        const end = points.at(-1)!;
        if (!drawing.props.isClosed && Math.hypot(end.x - points[0].x, end.y - points[0].y) > 12)
          throw new Error("Close the freehand outline (end within 12 chart pixels of the start), then retry.");
        const polygon = validatePolygon(points.map(geometry.toAnalytical));
        const outline = {
          color: getDefaultColorTheme({ isDarkMode: false })[drawing.props.color].solid,
          width: (STROKE_SIZES[drawing.props.size] + 1) * drawing.props.scale,
          opacity: drawing.opacity,
          dash: drawing.props.dash,
        };
        const next: ScatterSelection =
          selection?.drawingId === drawing.id && !selection.outline
            ? {
                ...selection,
                chartId: shape.id,
                outline,
              }
            : {
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
                outline,
              };
        setCount(null);
        setSelectionError(null);
        // Automatic capture joins the draw gesture's history entry. An explicit
        // transfer has its own boundary so undo restores the original stroke.
        if (explicit) editor.markHistoryStoppingPoint("attach chart outline");
        editor.run(() => {
          selectedAreaPreview(editor).set(null);
          setMeta({ nativeSelection: JSON.stringify(next), nativeLassoError: null, nativeLassoDrawing: null });
          editor.deleteShapes([drawing.id]);
        });
        editor.markHistoryStoppingPoint("chart outline attached");
        if (!explicit) editor.setCurrentTool("select");
      } catch (error) {
        setCount(null);
        setSelectionError(message(error));
        setMeta({ nativeLassoDrawing: drawing.id, nativeLassoError: message(error) });
      }
    },
    [editor, shape.id, geometry, source, currentPlot, setMeta, canSelect, selection]
  );

  useEffect(() => {
    // Observe fresh pen gestures, including the canvas Draw tool. Completed
    // strokes restored by undo, paste, or document loading are not new gestures.
    const stopCreate = editor.sideEffects.registerAfterCreateHandler("shape", (record, changeSource) => {
      if (
        changeSource === "user" &&
        record.type === "draw" &&
        !(record as TLDrawShape).props.isComplete &&
        editor.getCurrentToolId() === "draw"
      ) {
        pendingDrawings.current.add(record.id);
      }
    });
    const stopChange = editor.sideEffects.registerAfterChangeHandler("shape", (before, after, changeSource) => {
      if (
        changeSource === "user" &&
        pendingDrawings.current.has(after.id) &&
        before.type === "draw" &&
        after.type === "draw" &&
        !(before as TLDrawShape).props.isComplete &&
        (after as TLDrawShape).props.isComplete
      ) {
        pendingDrawings.current.delete(after.id);
        queueMicrotask(() => {
          const drawing = editor.getShape<TLDrawShape>(after.id);
          if (drawing?.type === "draw" && drawing.props.isComplete) acceptDrawing(drawing);
        });
      }
    });
    const stopDelete = editor.sideEffects.registerAfterDeleteHandler("shape", (record) => {
      pendingDrawings.current.delete(record.id);
    });
    return () => {
      stopCreate();
      stopChange();
      stopDelete();
    };
  }, [editor, acceptDrawing]);

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
  }, [coordinator, selection, selectionCurrent, currentPlot, refresh, visible]);

  const branchController = useRef<AbortController | null>(null);
  useEffect(() => () => branchController.current?.abort(), []);
  const explore = async () => {
    if (!selection || !source || count === null || !selectionCurrent) return;
    setExploring(true);
    try {
      const latest = scatterSource(editor, shape);
      if (latest.revision !== selection.sourceRevision)
        throw new Error("The upstream query changed. Draw a new selection.");
      const text = "SELECT * FROM selected_area";
      const id = createShapeId();
      const bounds = editor.getShapePageBounds(shape.id)!;
      editor.createShape<SQLTextAreaShape>({
        id,
        type: "sql-text-area",
        x: bounds.maxX + 60,
        y: bounds.y,
        props: { name: getUniqueName(editor, `${latest.name}_selected`), text, isDirty: true, showTable: true },
        meta: { nativeSelection: JSON.stringify(selection), selectedAreaLimit: shape.props.limit },
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
  const maximum = useMemo(
    () => currentPlot?.marks.reduce((max, mark) => Math.max(max, mark.count), 1) ?? 1,
    [currentPlot]
  );
  const legendColor = densityScale(maximum);
  const legendGradient = `linear-gradient(to right, ${[0, 0.25, 0.5, 0.75, 1]
    .map((t) =>
      shape.props.color
        ? `rgba(0,0,0,${densityOpacity(Math.pow(maximum, t), maximum)})`
        : legendColor(Math.pow(maximum, t))
    )
    .join(", ")})`;
  const numericColumns =
    source?.schema.filter((column) => isNumericColumn(column.type) || column.name === shape.props.y) ?? [];
  const excluded = currentPlot?.excluded ?? 0;
  const retryDrawing = () => {
    const drawingId = shape.meta.nativeLassoDrawing ?? (!selection?.outline ? selection?.drawingId : null);
    const drawing =
      editor.getSelectedShapes().find((s) => s.type === "draw") ??
      (typeof drawingId === "string" ? editor.getShape(drawingId as TLShapeId) : undefined);
    if (drawing?.type === "draw") acceptDrawing(drawing as TLDrawShape, true);
    else setSelectionError("Select a freehand drawing, then retry.");
  };
  const download = async (format: "svg" | "png") => {
    if (!currentPlot) return;
    setExporting(true);
    try {
      await exportNativeChart(
        currentPlot,
        width,
        height,
        visiblePolygon,
        source?.name ?? "chart",
        format,
        (preview ?? selection)?.outline
      );
    } catch (error) {
      setSelectionError(message(error));
    } finally {
      setExporting(false);
    }
  };
  const updateProps = (props: Partial<ChartShape["props"]>) =>
    editor.updateShape<ChartShape>({ id: shape.id, type: "chart-shape", props });
  const clearSelection = () => {
    selectedAreaPreview(editor).set(null);
    setSelectionError(null);
    setCount(null);
    editor.markHistoryStoppingPoint("clear chart outline");
    setMeta({ nativeSelection: null, nativeLassoError: null, nativeLassoDrawing: null });
    editor.markHistoryStoppingPoint("chart outline cleared");
  };
  return (
    <HTMLContainer
      id={shape.id}
      className="kavla-scatter"
      style={{
        width: shape.props.w,
        height: shape.props.h,
        border: "4px solid black",
        borderRadius: 12,
        background: "white",
        boxSizing: "border-box",
        pointerEvents: "all",
      }}
    >
      <div className="kavla-scatter__header" style={{ height: headerHeight }}>
        <strong className="kavla-scatter__title" title={source?.name ?? "Chart"}>
          {source?.name ?? "CHART"}
        </strong>
      </div>
      <div className="kavla-chart__body" style={{ height: height + controlsHeight }}>
        <div className="kavla-chart__content" style={{ width }}>
          <div style={{ position: "relative", width, height, overflow: "hidden" }} aria-busy={busy}>
            {geometry && currentPlot && (
              <>
                {kind === "scatter" ? (
                  <ScatterMarks
                    marks={currentPlot.marks}
                    geometry={geometry}
                    plan={currentPlot.plan}
                    polygon={visiblePolygon}
                    width={width}
                    height={height}
                    renderer={renderer}
                    pixelRatio={pixelRatio}
                    colorBy={Boolean(shape.props.color)}
                  />
                ) : (
                  <SeriesMarks
                    data={currentPlot}
                    geometry={geometry}
                    width={width}
                    height={height}
                    renderer={renderer}
                    pixelRatio={pixelRatio}
                  />
                )}
                <ScatterAxes
                  geometry={geometry}
                  width={width}
                  height={height}
                  xLabel={currentPlot.x.field + (xLog ? " · log" : "")}
                  yLabel={currentPlot.y.field + (yLog ? " · log" : "")}
                  polygon={visiblePolygon}
                  outline={(preview ?? selection)?.outline}
                  xKind={currentPlot.xKind}
                  categories={currentPlot.categories}
                />
                {!errorText && !settingsOpen && (
                  <ScatterTooltip
                    editor={editor}
                    shapeId={shape.id}
                    marks={currentPlot.marks}
                    geometry={geometry}
                    plan={currentPlot.plan}
                    width={width}
                    height={height}
                    plotOffset={{ x: 4, y: 4 + headerHeight }}
                    xLabel={currentPlot.x.field}
                    yLabel={currentPlot.y.field}
                    data={currentPlot}
                  />
                )}
              </>
            )}
            {(!currentPlot || !currentPlot.valid || errorText) && (
              <div role="status" className="kavla-scatter__message">
                <strong>
                  {errorText ? <CircleAlert size={17} /> : <ScatterChart size={17} />}
                  {errorText
                    ? "Chart needs attention"
                    : busy
                      ? "Plotting your data"
                      : currentPlot
                        ? "No plottable rows"
                        : "Choose your axes"}
                </strong>
                <p>
                  {errorText ||
                    (busy
                      ? "Reading the full dataset…"
                      : currentPlot
                        ? "These axes have no finite values. Check the columns below or transform the values in your SQL query."
                        : "Choose X and Y columns in the bar below.")}
                </p>
              </div>
            )}
          </div>
          {!compact && (
            <div
              className="kavla-scatter__footer"
              style={{ height: controlsHeight }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div className="kavla-scatter__status">
                <span
                  className="kavla-scatter__rows"
                  title={
                    currentPlot
                      ? `${currentPlot.total.toLocaleString()} source rows. ${excluded.toLocaleString()} rows excluded because coordinates are missing, non-finite, or not positive on a log axis. All eligible rows contribute to the plot.`
                      : undefined
                  }
                >
                  {currentPlot ? (
                    <>
                      <b>{currentPlot.total.toLocaleString()}</b> rows
                      {excluded > 0 && (
                        <span className="kavla-scatter__notice"> · {excluded.toLocaleString()} excluded</span>
                      )}
                    </>
                  ) : (
                    "No plot yet"
                  )}
                  {busy && " · Updating…"}
                </span>
                {currentPlot?.plan.mode === "density" && (
                  <span
                    className="kavla-scatter__legend"
                    title={`Rows per bin, logarithmic ${shape.props.color ? "opacity" : "color"} scale from 1 to ${maximum.toLocaleString()}. ${shape.props.color ? "Colored strips show each group's share of the bin. " : ""}Yellow bins preview the selection; the selected row count is exact.`}
                  >
                    <span className="kavla-scatter__optional">Rows / bin</span>
                    <span>1</span>
                    <span className="kavla-scatter__ramp" style={{ background: legendGradient }} />
                    {maximum > 1 && (
                      <span>
                        {new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
                          maximum
                        )}
                      </span>
                    )}
                  </span>
                )}
                {currentPlot?.page && currentPlot.page.total > currentPlot.page.size && (
                  <div className="kavla-chart__pages">
                    <button
                      className="kavla-scatter__button kavla-scatter__button--icon"
                      aria-label="Previous categories"
                      disabled={busy || currentPlot.page.offset === 0}
                      onClick={() => setPageOffset(currentPlot.page!.offset - currentPlot.page!.size)}
                    >
                      <ChevronLeft size={14} />
                    </button>
                    <span>
                      {currentPlot.page.offset + 1}–
                      {Math.min(currentPlot.page.total, currentPlot.page.offset + currentPlot.page.size)} /{" "}
                      {currentPlot.page.total.toLocaleString()}
                    </span>
                    <button
                      className="kavla-scatter__button kavla-scatter__button--icon"
                      aria-label="Next categories"
                      disabled={busy || currentPlot.page.offset + currentPlot.page.size >= currentPlot.page.total}
                      onClick={() => setPageOffset(currentPlot.page!.offset + currentPlot.page!.size)}
                    >
                      <ChevronRight size={14} />
                    </button>
                  </div>
                )}
              </div>
              {shape.props.color && (
                <div
                  className="kavla-chart__legend"
                  onWheel={(event) => event.stopPropagation()}
                  aria-label={`Color: ${shape.props.color}`}
                >
                  {currentPlot?.groups.map((group) => (
                    <span key={JSON.stringify(group)} title={group ?? "(null)"}>
                      <i style={{ background: groupColor(group) }} />
                      {group ?? "(null)"}
                    </span>
                  ))}
                </div>
              )}
              {preview ? (
                <div className="kavla-scatter__actions">
                  <span className="kavla-scatter__hint kavla-scatter__selection" role="status">
                    {preview.x.field === currentPlot?.x.field && preview.y.field === currentPlot?.y.field
                      ? "selected_area"
                      : `Area uses ${preview.x.field} / ${preview.y.field}`}
                  </span>
                  <button className="kavla-scatter__button" onClick={() => selectedAreaPreview(editor).set(null)}>
                    Back to current selection
                  </button>
                </div>
              ) : (
                selection &&
                canSelect && (
                  <div className="kavla-scatter__actions">
                    <span
                      className="kavla-scatter__hint kavla-scatter__selection"
                      role="status"
                      title="Exact count from the original rows, including duplicate coordinates. Density highlights are a preview."
                    >
                      {selectionCurrent
                        ? count === null
                          ? "Counting…"
                          : `${count.toLocaleString()} selected`
                        : "Selection out of date"}
                    </span>
                    {selectionCurrent && (
                      <button
                        type="button"
                        className="kavla-scatter__button kavla-scatter__button--primary"
                        title="Explore selected rows in a new SQL query"
                        disabled={count === null || exploring}
                        onClick={() => void explore()}
                      >
                        {exploring ? "Running…" : "Explore"}
                        <ArrowUpRight size={14} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="kavla-scatter__button kavla-scatter__button--icon"
                      title="Clear selection"
                      aria-label="Clear selection"
                      onClick={clearSelection}
                    >
                      <X size={14} />
                    </button>
                  </div>
                )
              )}
            </div>
          )}
        </div>
        <div
          className="kavla-chart__action-bar"
          role="group"
          aria-label="Chart actions"
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
        >
          <div className="kavla-chart__action-types" role="group" aria-label="Chart type">
            {(
              [
                ["scatter", ScatterChart],
                ["line", LineChart],
                ["bar", BarChart3],
                ["area", AreaChart],
              ] as const
            ).map(([type, Icon]) => (
              <button
                key={type}
                type="button"
                className="kavla-scatter__button kavla-scatter__button--icon"
                title={`${type[0].toUpperCase() + type.slice(1)} chart`}
                aria-label={`${type[0].toUpperCase() + type.slice(1)} chart`}
                aria-pressed={kind === type}
                onClick={() => updateProps({ chartType: type })}
              >
                <Icon size={18} />
              </button>
            ))}
            {canSelect && (
              <button
                type="button"
                className="kavla-scatter__button kavla-scatter__button--icon"
                disabled={!currentPlot}
                title={capturing ? "Cancel drawing an outline" : "Draw a closed outline to select rows"}
                aria-label={selection ? "Redraw selection" : "Select rows"}
                aria-pressed={capturing}
                onClick={() => {
                  setSelectionError(null);
                  editor.setCurrentTool(capturing ? "select" : "draw");
                }}
              >
                <Lasso size={18} />
              </button>
            )}
          </div>
          <div className="kavla-chart__action-tools">
            <button
              type="button"
              className="kavla-scatter__button kavla-scatter__button--icon"
              title="Refresh data"
              aria-label="Refresh data"
              disabled={busy}
              onClick={() => {
                setSelectionError(null);
                setRefresh((n) => n + 1);
              }}
            >
              <RefreshCw size={16} className={busy ? "kavla-scatter__busy" : undefined} />
            </button>
            <button
              ref={settingsButton}
              type="button"
              className="kavla-scatter__button kavla-scatter__button--icon"
              title="Options"
              aria-label="Chart options"
              aria-expanded={settingsOpen}
              aria-controls={settingsId}
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <Settings2 size={18} />
            </button>
          </div>
        </div>
      </div>
      <div
        className="kavla-chart__axis-bar"
        style={{ height: axisBarHeight }}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        {(["x", "y", "color"] as const).map((field) => {
          const value = shape.props[field] ?? "";
          const column = source?.schema.find((column) => column.name === value);
          const columns = field === "y" ? numericColumns : (source?.schema ?? []);
          return (
            <label key={field} className="kavla-scatter__field">
              <span>{field === "color" ? "Color" : `${field.toUpperCase()}-Axis`}</span>
              <span className={`kavla-chart__axis-select ${column ? getColumnTypeColor(column.type) : ""}`}>
                <select
                  aria-label={field === "color" ? "Color" : `${field.toUpperCase()} axis`}
                  title={value || (field === "color" ? "None" : "Choose a column")}
                  value={value}
                  disabled={!source?.schema.length}
                  onChange={(event) => updateProps({ [field]: event.target.value || null })}
                >
                  <option value="" disabled={field !== "color"}>
                    {field === "color" ? "None" : "Choose column"}
                  </option>
                  {value && !column && (
                    <option value={value} disabled>
                      {value} (unavailable)
                    </option>
                  )}
                  {columns.map((column) => (
                    <option key={column.name} value={column.name}>
                      {column.name}
                    </option>
                  ))}
                </select>
              </span>
            </label>
          );
        })}
      </div>
      {settingsOpen && (
        <div
          ref={settingsRef}
          id={settingsId}
          role="dialog"
          aria-label="Chart options"
          className="kavla-scatter__settings"
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
        >
          <div className="kavla-scatter__settings-heading">
            Options
            <button
              type="button"
              className="kavla-scatter__button kavla-scatter__button--icon"
              aria-label="Close options"
              onClick={() => {
                setSettingsOpen(false);
                settingsButton.current?.focus();
              }}
            >
              <X size={14} />
            </button>
          </div>
          {(kind === "bar" || kind === "area") && shape.props.color && (
            <div className="kavla-scatter__scales" role="group" aria-label="Series layout">
              {[false, true].map((value) => (
                <button
                  key={String(value)}
                  className="kavla-scatter__button"
                  aria-pressed={Boolean(shape.props.isStacked) === value}
                  onClick={() => updateProps({ isStacked: value })}
                >
                  {value ? "Stacked" : "Grouped"}
                </button>
              ))}
            </div>
          )}
          {!shape.props.x && !shape.props.y && numericColumns.length > 0 && (
            <button
              className="kavla-scatter__button"
              onClick={() => {
                const x =
                  source?.schema.find((column) => /^(DATE|TIMESTAMP)/i.test(column.type)) ??
                  numericColumns[1] ??
                  source?.schema.find((column) => column.name !== numericColumns[0].name) ??
                  numericColumns[0];
                updateProps({
                  x: x.name,
                  y: numericColumns[0].name,
                  chartType: /^(DATE|TIMESTAMP)/i.test(x.type) ? "line" : isNumericColumn(x.type) ? "scatter" : "bar",
                });
              }}
            >
              Suggest axes
            </button>
          )}
          {canSelect && (
            <button
              type="button"
              className="kavla-scatter__button"
              onClick={() => {
                retryDrawing();
                setSettingsOpen(false);
              }}
            >
              Use existing drawing
            </button>
          )}
          <div className="kavla-scatter__scales">
            <button
              className="kavla-scatter__button"
              disabled={!currentPlot || exporting}
              onClick={() => void download("png")}
            >
              Export PNG
            </button>
            <button
              className="kavla-scatter__button"
              disabled={!currentPlot || exporting}
              onClick={() => void download("svg")}
            >
              Export SVG
            </button>
          </div>
          {compact && currentPlot?.page && currentPlot.page.total > currentPlot.page.size && (
            <div className="kavla-scatter__scales">
              <button
                className="kavla-scatter__button"
                disabled={busy || currentPlot.page.offset === 0}
                onClick={() => setPageOffset(currentPlot.page!.offset - currentPlot.page!.size)}
              >
                Previous categories
              </button>
              <button
                className="kavla-scatter__button"
                disabled={busy || currentPlot.page.offset + currentPlot.page.size >= currentPlot.page.total}
                onClick={() => setPageOffset(currentPlot.page!.offset + currentPlot.page!.size)}
              >
                Next categories
              </button>
            </div>
          )}
          {saved.error && (
            <button className="kavla-scatter__button" onClick={clearSelection}>
              Clear unsupported selection
            </button>
          )}
          {selection && (compact || !canSelect) && (
            <button className="kavla-scatter__button" onClick={clearSelection}>
              Clear outline
            </button>
          )}
          <p className="kavla-scatter__settings-note">
            {kind === "bar"
              ? "Bars keep the first value for each category and color, matching saved charts. Aggregate in SQL to plot totals."
              : "All eligible rows contribute. Large scatterplots use density bins; large lines preserve extrema and gaps."}
          </p>
        </div>
      )}
    </HTMLContainer>
  );
}
