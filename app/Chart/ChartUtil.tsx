import {
  HTMLContainer,
  Rectangle2d,
  ShapeUtil,
  TLResizeInfo,
  resizeBox,
  TLShapeId,
  useValue,
  TLShape,
  TLDragShapesOverInfo,
  TLDragShapesOutInfo,
  TLDrawShape,
  TLDrawShapeSegment,
} from "tldraw";
import { ChartShape } from "./chart-shape-types";
import { ChartShapeProps } from "./chart-shape-props";
import { ChartShapeMigrations } from "./chart-shape-migrations";
import { useCallback, useEffect, useState, useRef, useMemo } from "react";
import ReactECharts from "echarts-for-react";
import { useQueryResultRows } from "../client/useQueryResultRows";
import type { SQLTextAreaShape } from "../SQLTextArea/sql-text-area-types";
import { guessChartOptions } from "./chart-heuristics";
import { ChartActionBar } from "./ChartActionBar";
import { ChartBody } from "./ChartBody";
import { ChartFooter } from "./ChartFooter";
import { ChartHeader } from "./ChartHeader";
import { buildChartOption, normalizeChartRow } from "./chartOptions";
import { ensureLocalQueryView } from "../SQLTextArea/sqlDagDependencies";
import { restoreRemoteQueryView } from "../SQLTextArea/restoreRemoteQueryView";
import { useData } from "../client/useLocalServer";

function canUseStackedLayout(chartType: string | null) {
  return chartType === "bar" || chartType === "area";
}

const initialChildrenState = new Map<
  TLShapeId,
  {
    children: { id: TLShapeId; shape: TLShape }[];
  }
>();

export class ChartUtil extends ShapeUtil<ChartShape> {
  static override type = "chart-shape" as const;
  static override props = ChartShapeProps;
  static override migrations = ChartShapeMigrations;

  canReceiveNewChildrenOfType(shape: ChartShape, type: TLShape["type"]) {
    if (shape.isLocked) return false;
    return !["data-source", "sql-text-area", "sql-result-table", "chart-shape"].includes(type);
  }

  providesBackgroundForChildren(): boolean {
    return true;
  }

  canResizeChildren(): boolean {
    return false;
  }

  onDragShapesIn(shape: ChartShape, draggingShapes: TLShape[], _info: TLDragShapesOverInfo) {
    const { editor } = this;

    if (draggingShapes.every((s) => s.parentId === shape.id)) return;

    const allowedShapes = draggingShapes.filter((s) => {
      const allowed = this.canReceiveNewChildrenOfType(shape, s.type);
      return allowed;
    });

    if (allowedShapes.length > 0) {
      editor.reparentShapes(allowedShapes, shape.id);
    }
  }

  onDragShapesOut(shape: ChartShape, draggingShapes: TLShape[], info: TLDragShapesOutInfo): void {
    const { editor } = this;
    if (!info.nextDraggingOverShapeId) {
      // An invalid child must still be able to leave the chart.
      editor.reparentShapes(
        draggingShapes.filter((s) => s.parentId === shape.id),
        editor.getCurrentPageId()
      );
    }
  }

  getDefaultProps(): ChartShape["props"] {
    return {
      sourceShapeId: null,
      chartType: "scatter",
      x: null,
      y: null,
      color: null,
      yAxisScale: "default",
      isStacked: false,
      limit: null,
      w: 600,
      h: 400,
      name: "chart",
    };
  }

  getGeometry(shape: ChartShape) {
    return new Rectangle2d({
      width: shape.props.w,
      height: shape.props.h,
      isFilled: true,
    });
  }

  component(shape: ChartShape) {
    const { sourceShapeId, chartType, x, y, color, yAxisScale, isStacked, limit } = shape.props;
    const resolvedLimit = Math.max(1, Math.min(10000, Math.round(limit ?? 10000)));

    const resolvedYAxisScale =
      yAxisScale === "default" ? (chartType === "bar" || chartType === "area" ? "zero" : "auto") : yAxisScale || "auto";

    const getSourceShape = useCallback(() => {
      if (!sourceShapeId) return undefined;
      const candidate = this.editor.getShape(sourceShapeId as TLShapeId);
      return candidate?.type === "sql-text-area" ? (candidate as SQLTextAreaShape) : undefined;
    }, [sourceShapeId]);
    const hasSource = useValue("chart source exists", () => Boolean(getSourceShape()), [getSourceShape]);
    const sourceName = useValue("chart source name", () => getSourceShape()?.props.name ?? null, [getSourceShape]);
    const sourceSchema = useValue("chart source schema", () => getSourceShape()?.props.outputSchema ?? null, [
      getSourceShape,
    ]);
    const sourceResultStats = useValue("chart source result", () => getSourceShape()?.props.lastRunStats ?? null, [
      getSourceShape,
    ]);
    const isCLIResult = sourceResultStats?.runnerName === "CLI";
    const { runRemoteQuery } = useData();
    const ensureSourceTable = useCallback(async () => {
      const sourceShape = getSourceShape();
      if (!sourceShape) throw new Error("The query shape is unavailable.");
      await ensureLocalQueryView(this.editor, sourceShape);
    }, [getSourceShape]);
    const restoreServerResult = useCallback(async () => {
      const sourceShape = getSourceShape();
      if (!sourceShape) throw new Error("The query shape is unavailable.");
      await restoreRemoteQueryView(this.editor, sourceShape, runRemoteQuery);
    }, [getSourceShape, runRemoteQuery]);

    const {
      data,
      columns,
      columnTypes,
      error: localError,
      isLoading,
      isTruncated,
    } = useQueryResultRows({
      sourceShapeId: sourceShapeId ? (sourceShapeId as TLShapeId) : null,
      sourceTableName: sourceName,
      schema: sourceSchema,
      revision: sourceResultStats,
      limit: resolvedLimit,
      normalizeRow: normalizeChartRow,
      serverResultShapeId: isCLIResult && sourceShapeId ? (sourceShapeId as TLShapeId) : null,
      ensureSourceTable: isCLIResult ? undefined : ensureSourceTable,
      restoreServerResult: isCLIResult ? restoreServerResult : undefined,
    });
    const showWarning = resolvedLimit >= 10000 && isTruncated;

    const [hasResetColumns, setHasResetColumns] = useState(false);

    const editor = this.editor;
    useEffect(() => {
      if (columns.length > 0) {
        let updates: Partial<ChartShape["props"]> = {};
        let needsUpdate = false;

        if (x && !columns.includes(x)) {
          updates.x = null;
          needsUpdate = true;
        }
        if (y && !columns.includes(y)) {
          updates.y = null;
          needsUpdate = true;
        }
        if (color && !columns.includes(color)) {
          updates.color = null;
          needsUpdate = true;
        }

        if (needsUpdate) {
          editor.updateShape({
            id: shape.id,
            type: "chart-shape",
            props: updates,
          });
          setHasResetColumns(true);
        } else {
          if (x && y && columns.includes(x) && columns.includes(y)) {
            setHasResetColumns(false);
          }
        }
      }
    }, [columns, x, y, color, shape.id, editor]);

    const suggestedOptions = useMemo(() => {
      if (!x && !y && data.length > 0 && columns.length > 0) {
        return guessChartOptions(data, columns);
      }
      return null;
    }, [x, y, data, columns]);

    const zoomLevel = useValue("zoom level", () => this.editor.getZoomLevel(), []);
    const [dpr, setDpr] = useState(typeof window !== "undefined" ? window.devicePixelRatio : 1);

    useEffect(() => {
      const handleZoom = () => {
        const newDpr = window.devicePixelRatio * zoomLevel;
        if (Math.abs(newDpr - dpr) > 0.2) {
          setDpr(newDpr);
        }
      };

      const timer = setTimeout(handleZoom, 200);
      return () => clearTimeout(timer);
    }, [zoomLevel, dpr]);

    const option = useMemo(
      () =>
        buildChartOption({
          chartHeight: shape.props.h,
          chartType,
          color,
          columnTypes,
          data,
          isStacked,
          resolvedYAxisScale,
          x,
          y,
        }),
      [data, x, y, color, chartType, shape.props.h, resolvedYAxisScale, isStacked, columnTypes]
    );
    const chartStyle = useMemo(() => ({ height: "100%", width: "100%", minWidth: 1, minHeight: 1 }), []);

    // SVG stays sharp while zooming; large datasets use canvas to limit DOM work.
    const renderer: "svg" | "canvas" = data.length < 1000 ? "svg" : "canvas";

    const chartOpts = useMemo(
      () => ({
        renderer,
        devicePixelRatio: renderer === "canvas" ? dpr : undefined,
      }),
      [renderer, dpr]
    );

    const setYAxisScale = (scaleMode: string) => {
      this.editor.updateShape({
        id: shape.id,
        type: "chart-shape",
        props: { yAxisScale: scaleMode },
      });
    };

    const setIsStacked = (stacked: boolean) => {
      this.editor.updateShape({
        id: shape.id,
        type: "chart-shape",
        props: { isStacked: stacked },
      });
    };

    const setLimit = (nextLimit: number | null) => {
      this.editor.updateShape({
        id: shape.id,
        type: "chart-shape",
        props: { limit: nextLimit },
      });
    };

    const setChartType = (type: string) => {
      this.editor.updateShape({
        id: shape.id,
        type: "chart-shape",
        props: {
          chartType: type,
          ...(color && canUseStackedLayout(type) ? { isStacked: true } : {}),
        },
      });
    };

    const setX = (col: string) => {
      this.editor.updateShape({
        id: shape.id,
        type: "chart-shape",
        props: { x: col },
      });
    };

    const setY = (col: string) => {
      this.editor.updateShape({
        id: shape.id,
        type: "chart-shape",
        props: { y: col },
      });
    };

    const setColor = (col: string | null) => {
      this.editor.updateShape({
        id: shape.id,
        type: "chart-shape",
        props: {
          color: col,
          ...(col && canUseStackedLayout(chartType) ? { isStacked: true } : {}),
        },
      });
    };

    const chartRef = useRef<ReactECharts>(null);

    return (
      <HTMLContainer
        id={shape.id}
        style={{
          border: "4px solid #000",
          borderRadius: 12,
          display: "flex",
          flexDirection: "column",
          pointerEvents: "all",
          padding: 0,
          backgroundColor: "#fff",
          height: "100%",
          boxSizing: "border-box",
          // Overflow must remain visible because dropdowns render outside the shape.
          fontFamily: "Inter, sans-serif",
        }}
        onPointerDown={() => {}}
      >
        <ChartHeader sourceName={sourceName || "..."} />

        <div style={{ display: "flex", flex: 1, minHeight: 0, minWidth: 0 }}>
          <ChartBody
            chartOpts={chartOpts}
            chartRef={chartRef}
            chartStyle={chartStyle}
            dataCount={data.length}
            hasResetColumns={hasResetColumns}
            hasSource={hasSource}
            isLoading={isLoading}
            localError={localError}
            option={option}
            resolvedLimit={resolvedLimit}
            showWarning={showWarning}
            suggestedOptions={suggestedOptions}
            x={x}
            y={y}
            onApplySuggestedOptions={() => {
              if (!suggestedOptions) return;
              editor.updateShape({
                id: shape.id,
                type: "chart-shape",
                props: suggestedOptions,
              });
            }}
          />

          <ChartActionBar
            chartRef={chartRef}
            chartType={chartType || "scatter"}
            fileName={sourceName || "chart"}
            isStacked={Boolean(isStacked)}
            limit={limit ?? null}
            yAxisScale={resolvedYAxisScale}
            onChartTypeChange={setChartType}
            onIsStackedChange={setIsStacked}
            onLimitChange={setLimit}
            onYAxisScaleChange={setYAxisScale}
          />
        </div>

        <ChartFooter
          color={color}
          columns={columns}
          columnTypes={columnTypes}
          hasSource={hasSource}
          x={x}
          y={y}
          onColorChange={setColor}
          onXChange={setX}
          onYChange={setY}
        />
      </HTMLContainer>
    );
  }

  indicator(shape: ChartShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={12} ry={12} />;
  }

  override onResizeStart(shape: ChartShape) {
    const children = this.editor
      .getSortedChildIdsForParent(shape.id)
      .map((id) => ({ id, shape: this.editor.getShape(id)! }));
    initialChildrenState.set(shape.id, { children });
  }

  override onResize(shape: ChartShape, info: TLResizeInfo<ChartShape>) {
    const { scaleX, scaleY } = info;
    const newShape = resizeBox(shape, info);

    const state = initialChildrenState.get(shape.id);
    if (state) {
      const { children } = state;
      this.editor.run(() => {
        children.forEach(({ shape: initialChild }) => {
          const newX = initialChild.x * scaleX;
          const newY = initialChild.y * scaleY;

          const changes: any = {
            x: newX,
            y: newY,
          };

          const hasW = "w" in initialChild.props && typeof initialChild.props.w === "number";
          const hasH = "h" in initialChild.props && typeof (initialChild.props as any).h === "number";

          if (hasW || hasH) {
            changes.props = {
              ...initialChild.props,
            };
            if (hasW) changes.props.w = (initialChild.props as any).w * scaleX;
            if (hasH) changes.props.h = (initialChild.props as any).h * scaleY;
          }

          if (initialChild.type === "draw") {
            const drawShape = initialChild as TLDrawShape;
            const newSegments: TLDrawShapeSegment[] = drawShape.props.segments.map((segment) => ({
              ...segment,
              points: segment.points.map((p) => ({
                x: p.x * scaleX,
                y: p.y * scaleY,
                z: p.z,
              })),
            }));

            changes.props = {
              ...changes.props,
              segments: newSegments,
            };
          }

          this.editor.updateShape({
            id: initialChild.id,
            type: initialChild.type,
            ...changes,
          });
        });
      });
    }

    return newShape;
  }

  override onResizeEnd(shape: ChartShape) {
    initialChildrenState.delete(shape.id);
  }
}
