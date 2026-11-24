import { useCallback, useEffect, useEffectEvent, useId, useMemo, useRef, useState } from "react";
import {
  HTMLContainer,
  getDefaultColorTheme,
  STROKE_SIZES,
  useValue,
  type Editor,
  type TLDrawShape,
  type TLShapeId,
} from "tldraw";
import {
  ArrowUpRight,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUpLeft,
  ArrowDownRight,
  ArrowDownLeft,
  CircleAlert,
  Contrast,
  Tag,
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
import { createLinkedQuery } from "../../SQLTextArea/createLinkedQuery";
import { chartSlice, type SliceSide } from "./chart-slice";
import { registerChartLasso } from "./chart-lasso";
import { lassoLoop } from "./lasso-loop";
import { joinLassoStrokes } from "./join-lasso-strokes";
import { chartGeometry, drawingToPlotPoints, firstPlotEntry, selectionBounds, selectionRegion } from "./geometry";
import { useSelectionDrag } from "./useSelectionDrag";
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
import {
  selectsPoint,
  hasSelectableArea,
  readSelections,
  serializeSelections,
  selectionSQL,
  validatePolygon,
  type ChartSelection,
  type Point,
} from "./selection";
import { getSelectedAreaSource, queriesForSelectedArea, type ChartRowsRelation } from "../../SQLTextArea/selected-area";
import { scatterSource } from "./source";
import { activeAreaChart, areaOnPlot, chartAreaValue, setGlobalArea } from "./global-selection";
import { ScatterMarks } from "./ScatterMarks";
import { ScatterAxes } from "./ScatterAxes";
import { ScatterTooltip } from "./ScatterTooltip";
import { useVisualizationSession } from "./VisualizationProvider";

const headerHeight = 42;
const axisBarHeight = 64;
const actionBarWidth = 48;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
type Loaded = ChartData & { revision: string };

const sideIcons = {
  Above: ArrowUp,
  Below: ArrowDown,
  Left: ArrowLeft,
  Right: ArrowRight,
  "Upper left": ArrowUpLeft,
  "Upper right": ArrowUpRight,
  "Lower left": ArrowDownLeft,
  "Lower right": ArrowDownRight,
};

type PendingSlice = {
  drawing: TLDrawShape;
  chartTransform: string;
  drawingTransform: string;
  requestKey: string;
  width: number;
  height: number;
  choices: { label: SliceSide; selection: ChartSelection }[];
};

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
  const canSelect = Boolean(source?.canSelect) && (kind === "line" || kind === "bar" || kind === "scatter");
  const areaValue = useValue("placed chart area", () => chartAreaValue(editor, shape), [editor, shape]);
  const saved = useMemo(() => {
    try {
      return { regions: readSelections(areaValue), error: null };
    } catch (error) {
      return { regions: [], error: message(error) };
    }
  }, [areaValue]);
  const { regions } = saved;
  const firstRegion = regions[0];
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const { exploredId, groupedId } = useValue(
    "chart drawing queries",
    () => {
      const queries = queriesForSelectedArea(editor, shape.id);
      const uses = (query: SQLTextAreaShape, name: ChartRowsRelation) =>
        getSelectedAreaSource(editor, query.props.text, query)?.relations.includes(name);
      return {
        exploredId: queries.find((query) => uses(query, "selected_area"))?.id,
        groupedId: queries.find((query) => query.meta.clusterQuery === true && uses(query, "clustered_rows"))?.id,
      };
    },
    [editor, shape.id]
  );
  const [slices, setSlices] = useState<PendingSlice[]>([]);
  const pendingSlice = slices[0];
  const dismissSlice = () => {
    setSlices((pending) => pending.filter((s) => s.drawing.id !== pendingSlice?.drawing.id));
    setHoveredSide(null);
  };
  const [hoveredSide, setHoveredSide] = useState<SliceSide | null>(null);
  const sliceDrawingCurrent = useValue(
    "chart slice drawing",
    () => {
      if (
        !pendingSlice ||
        editor.getShape(pendingSlice.drawing.id) !== pendingSlice.drawing ||
        !editor.getShape(shape.id)
      )
        return false;
      return (
        !editor.getIsReadonly() &&
        !editor.isShapeOrAncestorLocked(shape.id) &&
        !editor.isShapeOrAncestorLocked(pendingSlice.drawing.id) &&
        editor.getShapePageTransform(shape.id).toCssString() === pendingSlice.chartTransform &&
        editor.getShapePageTransform(pendingSlice.drawing.id).toCssString() === pendingSlice.drawingTransform
      );
    },
    [editor, shape.id, pendingSlice]
  );
  const currentTool = useValue("chart outline tool", () => editor.getCurrentToolId(), [editor]);
  const capturing = currentTool === "draw" && canSelect;
  const controlsHeight = compact ? 0 : 28 + (shape.props.color ? 24 : 0);
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
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const setMeta = useCallback(
    (patch: Record<string, string | boolean | null>) => {
      const current = editor.getShape(shape.id);
      if (current) editor.updateShape({ id: shape.id, type: "chart-shape", meta: { ...current.meta, ...patch } });
    },
    [editor, shape.id]
  );
  // Older documents kept the last failed drawing's message on the chart.
  useEffect(() => {
    const { nativeLassoError, nativeLassoDrawing } = shape.meta;
    if (typeof nativeLassoError !== "string" || typeof nativeLassoDrawing !== "string" || editor.getIsReadonly())
      return;
    const drawing = editor.getShape<TLDrawShape>(nativeLassoDrawing as TLShapeId);
    editor.run(
      () => {
        if (drawing?.type === "draw" && !drawing.meta.nativeLassoError) {
          editor.updateShape({ id: drawing.id, type: drawing.type, meta: { ...drawing.meta, nativeLassoError } });
        }
        setMeta({ nativeLassoError: null });
      },
      { history: "ignore" }
    );
  }, [editor, shape.meta.nativeLassoError, shape.meta.nativeLassoDrawing, setMeta]);
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
  const picked = useValue("selected chart", () => editor.getOnlySelectedShapeId() === shape.id, [editor, shape.id]);
  const previouslyPicked = useRef(picked);
  const waitingForPlot = useRef(false);

  function regionsToCarry() {
    if (activeAreaChart(editor)) return readSelections(editor.getCurrentPage().meta.nativeSelection);
    // A legacy page may have separate outlines per chart. Picking one adopts its outline.
    const oldCharts = editor.getCurrentPageShapes().filter((s) => s.type === "chart-shape" && s.meta.nativeSelection);
    const value = shape.meta.nativeSelection ?? (oldCharts.length === 1 ? oldCharts[0].meta.nativeSelection : null);
    if (!value && oldCharts.length > 1) return null;
    return readSelections(value);
  }

  function switchToChart() {
    if (editor.getIsReadonly() || editor.isShapeOrAncestorLocked(shape.id) || !canSelect || !source) return;
    if (!currentPlot || !geometry) {
      waitingForPlot.current = true;
      return;
    }
    waitingForPlot.current = false;
    const active = activeAreaChart(editor);
    if (active === shape.id) return;
    try {
      const areas = regionsToCarry();
      if (!areas) return;
      editor.markHistoryStoppingPoint("switch selected area to chart");
      setGlobalArea(
        editor,
        shape.id,
        areas.map((area) => areaOnPlot(area, shape, currentPlot, geometry, source))
      );
      editor.markHistoryStoppingPoint("selected area switched");
    } catch (error) {
      setSelectionError(message(error));
    }
  }
  const switchWhenReady = useEffectEvent(switchToChart);
  useEffect(() => {
    const justPicked = picked && !previouslyPicked.current;
    previouslyPicked.current = picked;
    if (justPicked) waitingForPlot.current = true;
    if (!picked) waitingForPlot.current = false;
    else if (waitingForPlot.current) switchWhenReady();
  }, [picked, currentPlot, canSelect]);

  // Rebind to the active page of categories and current scales when the plot changes.
  const refreshArea = useEffectEvent(() => {
    if (
      !canSelect ||
      !regions.length ||
      !currentPlot ||
      !geometry ||
      !source ||
      editor.getIsReadonly() ||
      editor.isShapeOrAncestorLocked(shape.id) ||
      activeAreaChart(editor) !== shape.id ||
      editor.getCurrentPage().meta.nativeSelection !== areaValue
    )
      return;
    const next = regions.map((area) => areaOnPlot(area, shape, currentPlot, geometry, source));
    if (serializeSelections(next) !== areaValue) {
      editor.run(() => setGlobalArea(editor, shape.id, next), { history: "ignore" });
    }
  });
  useEffect(() => {
    refreshArea();
  }, [currentPlot, geometry, canSelect, areaValue]);
  function matchesPlot(area: ChartSelection) {
    if (
      !currentPlot ||
      area.sourceId !== source?.id ||
      area.x.field !== currentPlot.x.field ||
      area.y.field !== currentPlot.y.field
    )
      return false;
    const series = area.series;
    if (!series) return kind === "scatter" && xKind === "number";
    if (series.kind === "bar")
      return kind === "bar" && series.color === shape.props.color && series.stacked === stacked;
    return kind === series.kind && series.xKind === xKind;
  }
  const selectionCurrent = Boolean(
    canSelect &&
    regions.length &&
    regions.every(
      (area) =>
        matchesPlot(area) &&
        area.sourceRevision === source?.revision &&
        area.x.type === currentPlot?.x.type &&
        area.y.type === currentPlot?.y.type
    )
  );
  const slice =
    pendingSlice &&
    sliceDrawingCurrent &&
    currentPlot &&
    pendingSlice.requestKey === requestKey &&
    pendingSlice.width === shape.props.w &&
    pendingSlice.height === shape.props.h &&
    pendingSlice.choices[0].selection.sourceId === source?.id
      ? pendingSlice
      : null;
  useEffect(() => {
    if (pendingSlice && !slice) dismissSlice();
  }, [pendingSlice, slice]);
  const hoveredSelection = slice?.choices.find((choice) => choice.label === hoveredSide)?.selection;
  // Older per-chart outlines used the axis domains at the time of drawing.
  const placed = useMemo(() => {
    if (!selectionCurrent || !geometry || !currentPlot) return [];
    if (activeAreaChart(editor) === shape.id) return regions;
    return regions.flatMap((area) => {
      if (
        currentPlot.page &&
        (area.x.domain[1] <= currentPlot.x.domain[0] || area.x.domain[0] >= currentPlot.x.domain[1])
      )
        return [];
      const original = chartGeometry(width, height, area.x, area.y);
      const polygon = area.polygon.map((p) => geometry.normalize(original.unproject(original.fromAnalytical(p))));
      return [{ ...area, polygon }];
    });
  }, [regions, selectionCurrent, geometry, currentPlot, width, height, editor, shape.id]);
  const canMove = useValue(
    "move chart selection",
    () => editor.isIn("select.idle") && !editor.getIsReadonly() && !editor.isShapeOrAncestorLocked(shape.id),
    [editor, shape.id]
  );
  const drag = useSelectionDrag(
    editor,
    canMove && !slice && !settingsOpen ? placed : [],
    geometry,
    currentPlot,
    shape.props.color,
    focusedId,
    setFocusedId,
    deleteDrawing,
    (next) => {
      if (
        editor.getIsReadonly() ||
        editor.isShapeOrAncestorLocked(shape.id) ||
        chartAreaValue(editor, shape) !== areaValue
      )
        return;
      editor.markHistoryStoppingPoint("edit chart drawing");
      setCount(null);
      setSelectionError(null);
      const updated = regions.map((r) => (r.drawingId === next.drawingId ? { ...next, chartId: shape.id } : r));
      setGlobalArea(editor, shape.id, updated);
      setMeta({ nativeLassoError: null, nativeLassoDrawing: null });
      editor.markHistoryStoppingPoint("chart drawing edited");
    }
  );
  const displayed = useMemo(() => {
    if (hoveredSelection) return [...placed, hoveredSelection];
    const draft = drag.draft;
    if (draft) return placed.map((r) => (r.drawingId === draft.drawingId ? draft : r));
    return placed;
  }, [placed, hoveredSelection, drag.draft]);
  const focused = canMove && !slice && !settingsOpen ? displayed.find((r) => r.drawingId === focusedId) : undefined;

  useEffect(() => {
    if (!focusedId) return;
    const dismiss = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(".kavla-scatter")?.id === shape.id &&
        target.closest("[data-chart-drawing]")
      )
        return;
      setFocusedId(null);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [focusedId, shape.id]);

  function commitSelection(next: ChartSelection, drawings: TLDrawShape[], separateHistory: boolean) {
    if (
      !currentPlot ||
      !geometry ||
      !source ||
      editor.getIsReadonly() ||
      editor.isShapeOrAncestorLocked(shape.id) ||
      drawings.some((d) => editor.getShape(d.id) !== d || editor.isShapeOrAncestorLocked(d.id))
    )
      return;
    setCount(null);
    setSelectionError(null);
    const drawingIds = drawings.map((d) => d.id);
    setSlices((pending) => pending.filter((s) => !drawingIds.includes(s.drawing.id)));
    setFocusedId(next.drawingId);
    setHoveredSide(null);
    const previous = (regionsToCarry() ?? []).filter((r) => r.drawingId !== next.drawingId);
    const areas = [...previous, next].map((r) => areaOnPlot(r, shape, currentPlot, geometry, source));
    // Automatic lasso capture joins the drawing gesture. A later side choice or
    // explicit attachment has its own undo boundary and restores the original pen stroke.
    if (separateHistory || drawings.length > 1) editor.markHistoryStoppingPoint("attach chart outline");
    editor.run(() => {
      setGlobalArea(editor, shape.id, areas);
      setMeta({ nativeLassoError: null, nativeLassoDrawing: null });
      editor.deleteShapes(drawingIds);
    });
    editor.markHistoryStoppingPoint("chart outline attached");
  }

  function markDrawingError(drawing: TLDrawShape, reason: string, open = false) {
    if (editor.getIsReadonly()) return;
    editor.updateShape({
      id: drawing.id,
      type: drawing.type,
      meta: { ...drawing.meta, nativeLassoError: reason, nativeOpenOutlineChart: open ? shape.id : null },
    });
    setMeta({ nativeLassoDrawing: drawing.id, nativeLassoError: null });
  }

  function getLassoTarget(drawing: TLDrawShape, explicit = false) {
    if (!canSelect || !geometry || !source || !currentPlot) {
      if (explicit) markDrawingError(drawing, "Wait for a current plot before selecting.");
      return null;
    }
    const transform = editor.getShapePageTransform(drawing);
    const pageToChart = editor.getShapePageTransform(shape.id).clone().invert();
    const plotPoints = (stroke: TLDrawShape) => {
      const strokeToPage = editor.getShapePageTransform(stroke);
      return drawingToPlotPoints(
        stroke.props.segments.flatMap((segment) => segment.points),
        (p) => strokeToPage.applyToPoint(p),
        (p) => pageToChart.applyToPoint(p),
        { x: 4, y: 4 + headerHeight }
      );
    };
    const points = plotPoints(drawing);
    if (!points.length) return null;
    const polygon = points.map(geometry.toAnalytical);
    const start = points[0];
    // A tap can pick an outline while the pen is active. Longer strokes can start inside any outline.
    const first = polygon[0];
    if (
      !explicit &&
      first.x >= 0 &&
      first.x <= 1 &&
      first.y >= 0 &&
      first.y <= 1 &&
      points.every((p) => Math.hypot(p.x - start.x, p.y - start.y) * editor.getZoomLevel() < 3)
    ) {
      const hit = [...placed].reverse().find((r) => selectsPoint(first, r));
      if (hit) {
        return {
          entry: 0,
          attach: () => {
            editor.deleteShapes([drawing.id]);
            editor.setCurrentTool("select");
            setFocusedId(hit.drawingId);
          },
        };
      }
    }
    const solo = lassoLoop(points, drawing.props.isClosed)?.map(geometry.toAnalytical);
    let loop = solo && hasSelectableArea(solo) ? solo : null;
    let drawings = [drawing];
    if (!loop && points.length >= 2) {
      const chartBounds = editor.getShapeMaskedPageBounds(shape);
      const others = editor.getCurrentPageShapes().filter((s): s is TLDrawShape => {
        if (
          !editor.isShapeOfType<TLDrawShape>(s, "draw") ||
          s.id === drawing.id ||
          !s.props.isComplete ||
          s.props.isClosed ||
          editor.isShapeOrAncestorLocked(s.id)
        )
          return false;
        if (s.meta.nativeOpenOutlineChart === shape.id) return true;
        const bounds = editor.getShapeMaskedPageBounds(s);
        if (!bounds || !chartBounds?.collides(bounds)) return false;
        if (typeof s.meta.nativeOpenOutlineChart === "string") {
          const owner = editor.getShape(s.meta.nativeOpenOutlineChart as TLShapeId);
          if (owner && editor.getShapeMaskedPageBounds(owner)?.collides(bounds)) return false;
        }
        return true;
      });
      const joined = joinLassoStrokes(
        { drawing, points },
        others.map((d) => ({ drawing: d, points: plotPoints(d) }))
      );
      if (joined) {
        const joinedLoop = joined.polygon.map(geometry.toAnalytical);
        if (firstPlotEntry(joinedLoop, true) !== null) {
          loop = joinedLoop;
          drawings = joined.drawings;
        }
      }
    }
    // A loose tail alone must not give its chart ownership of a loop drawn on another chart.
    const loopEntry = loop ? firstPlotEntry(loop, true) : null;
    const entry = loop && loopEntry === null ? null : (firstPlotEntry(polygon, false) ?? loopEntry);
    const legacy = regions.find((r) => r.drawingId === drawing.id && !r.outline && matchesPlot(r));
    if (entry === null && !(explicit && legacy)) {
      if (explicit) markDrawingError(drawing, "Draw an outline that overlaps the plot.");
      return null;
    }

    const attach = () => {
      try {
        if (
          editor.getIsReadonly() ||
          editor.isShapeOrAncestorLocked(shape.id) ||
          editor.isShapeOrAncestorLocked(drawing.id)
        )
          throw new Error("Unlock the chart and drawing before attaching an outline.");
        if (!drawing.props.isComplete) throw new Error("Finish the drawing before selecting.");
        const sides = loop ? null : chartSlice(polygon, geometry.plot.width, geometry.plot.height);
        const crossesEdge = polygon.some(({ x, y }) => x <= 0 || x >= 1 || y <= 0 || y >= 1);
        if (!loop && !sides && !legacy && (!crossesEdge || !hasSelectableArea(polygon))) {
          markDrawingError(
            drawing,
            "Continue from an end with another stroke to close the outline.",
            points.length >= 2
          );
          return;
        }
        const outline = {
          color: getDefaultColorTheme({ isDarkMode: false })[drawing.props.color].solid,
          width: (STROKE_SIZES[drawing.props.size] + 1) * drawing.props.scale,
          opacity: drawing.opacity,
          dash: drawing.props.dash,
        };
        const makeSelection = (region: Point[]): ChartSelection => {
          const validatedPolygon = validatePolygon(region);
          return legacy
            ? { ...legacy, chartId: shape.id, outline }
            : {
                ...selectionRegion(currentPlot, geometry, validatedPolygon, shape.props.color),
                semantics: "observations",
                policy: "live",
                sourceId: source.id,
                sourceRevision: source.revision,
                sourceSQL: source.sql,
                chartId: shape.id,
                drawingId: drawing.id,
                outline,
              };
        };
        if (sides && !legacy) {
          const choices = sides.map(({ label, polygon }) => ({ label, selection: makeSelection(polygon) }));
          if (drawing.meta.nativeLassoError) {
            editor.updateShape({
              id: drawing.id,
              type: drawing.type,
              meta: { ...drawing.meta, nativeLassoError: null, nativeOpenOutlineChart: null },
            });
          }
          setSelectionError(null);
          setHoveredSide(null);
          setSlices((pending) => [
            ...pending.filter((s) => s.drawing.id !== drawing.id),
            {
              drawing: editor.getShape<TLDrawShape>(drawing.id)!,
              requestKey,
              choices,
              width: shape.props.w,
              height: shape.props.h,
              drawingTransform: transform.toCssString(),
              chartTransform: editor.getShapePageTransform(shape.id).toCssString(),
            },
          ]);
        } else {
          commitSelection(makeSelection(loop ?? polygon), drawings, explicit);
        }
      } catch (error) {
        markDrawingError(drawing, message(error));
      }
    };
    return { entry: entry ?? 0, attach };
  }

  const targetDrawing = useEffectEvent((drawing: TLDrawShape) => getLassoTarget(drawing));
  useEffect(() => registerChartLasso(editor, shape.id, (drawing) => targetDrawing(drawing)), [editor, shape.id]);

  useEffect(() => {
    setCount(null);
    if (!selectionCurrent || !firstRegion || !visible) return;
    const controller = new AbortController();
    let current = true;
    // Authoritative counts are always live and never use the result cache.
    const request = coordinator.query(
      `SELECT count(*) AS count FROM (${selectionSQL(firstRegion.sourceSQL, regions)})`,
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
  }, [coordinator, regions, firstRegion, selectionCurrent, currentPlot, refresh, visible]);

  const branchController = useRef<AbortController | null>(null);
  useEffect(() => () => branchController.current?.abort(), []);
  function createDrawingQuery(name: string, relation: ChartRowsRelation, focus = true) {
    const grouped = relation === "clustered_rows";
    const text = `SELECT\n  *\nFROM\n  ${relation}`;
    const id = createLinkedQuery(
      editor,
      shape.id,
      {
        name: getUniqueName(editor, `${name}_${grouped ? "clustered" : "selected"}`),
        text,
      },
      {
        focus,
        meta: { selectedAreaChartId: shape.id, ...(grouped ? { clusterQuery: true } : {}) },
      }
    );
    return { id, text };
  }
  async function openGroupedRows() {
    if (groupedId && editor.getShape(groupedId)) {
      editor.select(groupedId);
      editor.zoomToSelection({ animation: { duration: 250 } });
      return;
    }
    if (!source || !selectionCurrent) return;
    try {
      const { id, text } = createDrawingQuery(source.name, "clustered_rows");
      const controller = new AbortController();
      branchController.current = controller;
      const result = await executeSQLShape(editor, data, id, text, controller.signal, { createMissingKnobs: false });
      if (!result.success) throw new Error(result.error ?? "The grouped query failed.");
    } catch (error) {
      setSelectionError(message(error));
    }
  }

  const errorText = sourceInfo.error || error;
  const chartNotice = selectionError || saved.error || (currentPlot?.valid ? errorText : null);
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
    const drawingId = shape.meta.nativeLassoDrawing ?? regions.find((r) => !r.outline)?.drawingId;
    const drawing =
      editor.getSelectedShapes().find((s) => s.type === "draw") ??
      (typeof drawingId === "string" ? editor.getShape(drawingId as TLShapeId) : undefined);
    if (drawing?.type === "draw") getLassoTarget(drawing as TLDrawShape, true)?.attach();
    else setSelectionError("Select a freehand drawing, then retry.");
  };
  const download = async (format: "svg" | "png") => {
    if (!currentPlot) return;
    setExporting(true);
    try {
      await exportNativeChart(currentPlot, width, height, displayed, source?.name ?? "chart", format);
    } catch (error) {
      setSelectionError(message(error));
    } finally {
      setExporting(false);
    }
  };
  const updateProps = (props: Partial<ChartShape["props"]>) =>
    editor.updateShape<ChartShape>({ id: shape.id, type: "chart-shape", props });
  const groupDrawing =
    !slice && !settingsOpen && !drag.draft && canSelect && (canMove || capturing)
      ? displayed.find((r) => r.drawingId === focusedId)
      : undefined;
  function nameDrawing(value: string) {
    if (
      !groupDrawing ||
      !source ||
      !selectionCurrent ||
      editor.getIsReadonly() ||
      editor.isShapeOrAncestorLocked(shape.id) ||
      chartAreaValue(editor, shape) !== areaValue
    )
      return;
    const groupName = value.trim() || undefined;
    if (groupName === groupDrawing.groupName) return;
    editor.markHistoryStoppingPoint("name chart group");
    editor.run(() => {
      if (groupName && !groupedId) createDrawingQuery(source.name, "clustered_rows", false);
      // Updating the page schedules the linked query and its dependents, including on undo.
      setGlobalArea(
        editor,
        shape.id,
        regions.map((region) => (region.drawingId === groupDrawing.drawingId ? { ...region, groupName } : region))
      );
    });
    editor.markHistoryStoppingPoint("chart group named");
  }

  function invertDrawing() {
    if (
      !focused ||
      !currentPlot ||
      !geometry ||
      !source ||
      !canSelect ||
      editor.getIsReadonly() ||
      editor.isShapeOrAncestorLocked(shape.id) ||
      chartAreaValue(editor, shape) !== areaValue
    )
      return;
    const inverted = areaOnPlot({ ...focused, inverted: !focused.inverted }, shape, currentPlot, geometry, source);
    editor.markHistoryStoppingPoint("invert chart drawing");
    setGlobalArea(
      editor,
      shape.id,
      regions.map((r) => (r.drawingId === focused.drawingId ? inverted : r))
    );
    setCount(null);
    setSelectionError(null);
    editor.markHistoryStoppingPoint("chart drawing inverted");
  }

  function deleteDrawing(id: string | null) {
    if (
      editor.getIsReadonly() ||
      editor.isShapeOrAncestorLocked(shape.id) ||
      chartAreaValue(editor, shape) !== areaValue
    )
      return;
    editor.markHistoryStoppingPoint("delete chart drawing");
    setGlobalArea(editor, shape.id, id === null ? [] : regions.filter((r) => r.drawingId !== id));
    setCount(null);
    setFocusedId(null);
    setSelectionError(null);
    setMeta({ nativeLassoError: null, nativeLassoDrawing: null });
    editor.markHistoryStoppingPoint("chart drawing deleted");
  }
  const bounds = focused && selectionBounds(focused.polygon);
  let drawingActionsPosition;
  if (bounds && geometry) {
    const corner = geometry.fromAnalytical({ x: bounds.right, y: bounds.top });
    const left = geometry.fromAnalytical({ x: bounds.left, y: bounds.top }).x;
    drawingActionsPosition = {
      x: corner.x + 44 <= width ? corner.x + 12 : Math.max(2, left - 40),
      y: Math.max(14, Math.min(corner.y, height - 48)),
    };
  }
  const axes = geometry && currentPlot && (
    <ScatterAxes
      geometry={geometry}
      width={width}
      height={height}
      xLabel={currentPlot.x.field + (xLog ? " · log" : "")}
      yLabel={currentPlot.y.field + (yLog ? " · log" : "")}
      selections={displayed}
      previewId={hoveredSelection?.drawingId}
      focusedId={focused?.drawingId}
      xKind={currentPlot.xKind}
      categories={currentPlot.categories}
      handlersFor={canMove && !slice && !settingsOpen ? drag.handlersFor : undefined}
    />
  );
  const slicePrompt = slice && (
    <div
      className="kavla-scatter__actions kavla-chart__slice-choice"
      role="group"
      aria-label="Choose a side of the slice"
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") dismissSlice();
        event.stopPropagation();
      }}
    >
      <span className="kavla-scatter__hint">Select side</span>
      {slice.choices.map(({ label, selection: side }) => {
        const Icon = sideIcons[label];
        return (
          <button
            key={label}
            type="button"
            className="kavla-scatter__button"
            title={label}
            aria-label={label}
            onPointerEnter={() => setHoveredSide(label)}
            onPointerLeave={() => setHoveredSide(null)}
            onFocus={() => setHoveredSide(label)}
            onBlur={() => setHoveredSide(null)}
            onClick={() => commitSelection(side, [slice.drawing], true)}
          >
            <Icon size={14} aria-hidden />
            <span className="kavla-control-label">{label}</span>
          </button>
        );
      })}
      <button
        type="button"
        className="kavla-scatter__button kavla-scatter__button--icon"
        aria-label="Cancel slice"
        title="Cancel slice"
        onClick={() => dismissSlice()}
      >
        <X size={14} />
      </button>
    </div>
  );
  return (
    <HTMLContainer
      id={shape.id}
      className="kavla-scatter"
      onPointerDownCapture={(event) => {
        if (picked && currentTool === "select" && event.button === 0 && !editor.inputs.isPanning) switchToChart();
      }}
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
        {chartNotice && (
          <span role="status" aria-label={chartNotice} title={chartNotice}>
            <CircleAlert size={16} />
          </span>
        )}
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
                    selections={displayed}
                    width={width}
                    height={height}
                    renderer={renderer}
                    pixelRatio={pixelRatio}
                    colorBy={Boolean(shape.props.color)}
                  />
                ) : (
                  <SeriesMarks
                    data={currentPlot}
                    selections={displayed}
                    geometry={geometry}
                    width={width}
                    height={height}
                    renderer={renderer}
                    pixelRatio={pixelRatio}
                  />
                )}
                {!settingsOpen && !slice ? (
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
                  >
                    {axes}
                  </ScatterTooltip>
                ) : (
                  axes
                )}
              </>
            )}
            {focused && drawingActionsPosition && (
              <div
                role="group"
                aria-label="Drawing actions"
                className="kavla-chart__drawing-actions"
                style={{ left: drawingActionsPosition.x, top: drawingActionsPosition.y }}
                data-chart-drawing={focused.drawingId}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Escape") setFocusedId(null);
                }}
              >
                <button
                  type="button"
                  className="kavla-scatter__button kavla-scatter__button--icon"
                  aria-label="Delete selected drawing"
                  title="Delete selected drawing"
                  onClick={() => deleteDrawing(focused.drawingId)}
                >
                  <X size={14} aria-hidden />
                </button>
                <button
                  type="button"
                  className="kavla-scatter__button kavla-scatter__button--icon"
                  aria-label="Invert selection"
                  aria-pressed={Boolean(focused.inverted)}
                  title="Invert selection"
                  onClick={invertDrawing}
                >
                  <Contrast size={14} aria-hidden />
                </button>
              </div>
            )}
            {groupDrawing && (
              <DrawingGroupForm
                key={JSON.stringify([groupDrawing.drawingId, groupDrawing.groupName])}
                drawing={groupDrawing}
                regions={regions}
                save={nameDrawing}
                open={groupDrawing.groupName || groupedId ? () => void openGroupedRows() : undefined}
                dismiss={() => setFocusedId(null)}
              />
            )}
            {(!currentPlot || !currentPlot.valid) && (
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
          {(!compact || slice || ((firstRegion || exploredId) && canSelect)) && (
            <div
              className={`kavla-scatter__footer${slice ? " kavla-chart__choice-footer" : ""}${compact ? " kavla-chart__compact-footer" : ""}`}
              style={{ height: compact ? undefined : controlsHeight }}
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
                      {(firstRegion || exploredId) && canSelect && (
                        <span
                          className="kavla-scatter__selection"
                          role="status"
                          title={
                            kind === "bar"
                              ? "One plotted row per selected category and series."
                              : "Exact selected count from the original observations."
                          }
                        >
                          {" ("}
                          {drag.draft
                            ? drag.resizing
                              ? "Resizing selection…"
                              : "Moving selection…"
                            : !firstRegion
                              ? "0 selected"
                              : !selectionCurrent
                                ? "Selection out of date"
                                : count === null
                                  ? "Counting…"
                                  : `${count.toLocaleString()} selected`}
                          {")"}
                        </span>
                      )}
                      {excluded > 0 && (
                        <span className="kavla-scatter__notice"> · {excluded.toLocaleString()} excluded</span>
                      )}
                    </>
                  ) : (
                    "No plot yet"
                  )}
                  {busy && " · Updating…"}
                </span>
                {!compact && currentPlot?.plan.mode === "density" && (
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
                {!compact && currentPlot?.page && currentPlot.page.total > currentPlot.page.size && (
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
                {(selectionCurrent || exploredId) && canSelect && (
                  <button
                    type="button"
                    className="kavla-scatter__button kavla-scatter__button--primary"
                    title="Create a query from selected rows"
                    disabled={!source || Boolean(drag.draft)}
                    onClick={() => source && createDrawingQuery(source.name, "selected_area")}
                  >
                    Query
                    <ArrowUpRight size={14} />
                  </button>
                )}
              </div>
              {!compact && shape.props.color && (
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
              {slicePrompt}
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
                title={capturing ? "Finish drawing" : "Draw around rows or slice across the plot"}
                aria-label={capturing ? "Finish drawing" : firstRegion ? "Add selection drawing" : "Select rows"}
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
          {(saved.error || firstRegion) && (
            <button className="kavla-scatter__button" onClick={() => deleteDrawing(null)}>
              {saved.error ? "Clear unsupported selection" : "Clear all drawings"}
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

function DrawingGroupForm({
  drawing,
  regions,
  save,
  open,
  dismiss,
}: {
  drawing: ChartSelection;
  regions: ChartSelection[];
  save: (name: string) => void;
  open?: () => void;
  dismiss: () => void;
}) {
  const [name, setName] = useState(() => {
    if (drawing.groupName) return drawing.groupName;
    const taken = new Set(regions.map((region) => region.groupName));
    for (let index = 0; ; index++) {
      const suffix = index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
      const candidate = `Cluster ${suffix}`;
      if (!taken.has(candidate)) return candidate;
    }
  });
  const action = drawing.groupName ? (name.trim() ? "Rename group" : "Ungroup") : "Make group";
  return (
    <form
      className="kavla-chart__group-form"
      data-chart-drawing={drawing.drawingId}
      aria-label="Drawing group"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") dismiss();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        save(name);
      }}
    >
      <input
        aria-label="Group name"
        value={name}
        placeholder="Group name"
        onChange={(event) => setName(event.target.value)}
      />
      <button
        type="submit"
        className="kavla-scatter__button"
        title={action}
        disabled={name.trim() === (drawing.groupName ?? "")}
      >
        <Tag size={14} aria-hidden />
        <span className="kavla-control-label">{action}</span>
      </button>
      {open && (
        <button
          type="button"
          className="kavla-scatter__button kavla-scatter__button--icon"
          title="Open grouped rows"
          aria-label="Open grouped rows"
          onClick={open}
        >
          <ArrowUpRight size={14} aria-hidden />
        </button>
      )}
    </form>
  );
}
