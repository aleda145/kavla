import {
  Rectangle2d,
  ShapeUtil,
  TLResizeInfo,
  resizeBox,
  TLShapeId,
  TLShape,
  TLDragShapesOverInfo,
  TLDragShapesOutInfo,
  TLDrawShape,
  TLDrawShapeSegment,
} from "tldraw";
import { ChartShape } from "./chart-shape-types";
import { ChartShapeProps } from "./chart-shape-props";
import { ChartShapeMigrations } from "./chart-shape-migrations";
import { NativeChart } from "./native/NativeChart";

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
    return !["data-source", "sql-text-area", "sql-result-table", "chart-shape", "lens-shape", "summary-shape"].includes(
      type
    );
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
    return <NativeChart editor={this.editor} shape={shape} />;
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
    // Preserve the two existing annotation-resize behaviors in saved documents.
    if (shape.meta.nativeVisualization === true && shape.props.chartType === "scatter")
      return resizeBox(shape, info, { minWidth: 320, minHeight: 320 });
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
