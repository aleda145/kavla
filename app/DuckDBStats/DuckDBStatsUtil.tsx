import { HTMLContainer, Rectangle2d, ShapeUtil, T, resizeBox } from "tldraw";
import type { TLBaseShape, TLResizeInfo } from "tldraw";
import { DuckDBStatsPanel } from "./DuckDBStatsPanel";

type DuckDBStatsShape = TLBaseShape<"duckdb-stats", { w: number; h: number }>;

export class DuckDBStatsUtil extends ShapeUtil<DuckDBStatsShape> {
  static override type = "duckdb-stats" as const;
  static override props = { w: T.number, h: T.number };
  override canEdit() {
    return false;
  }
  override canResize() {
    return true;
  }
  getDefaultProps() {
    return { w: 360, h: 370 };
  }
  getGeometry(shape: DuckDBStatsShape) {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true });
  }
  override onResize(shape: DuckDBStatsShape, info: TLResizeInfo<DuckDBStatsShape>) {
    return resizeBox(shape, info, { minWidth: 320, minHeight: 370 });
  }
  indicator(shape: DuckDBStatsShape) {
    return <rect width={shape.props.w} height={shape.props.h} />;
  }
  component(shape: DuckDBStatsShape) {
    return (
      <HTMLContainer
        id={shape.id}
        style={{
          width: shape.props.w,
          height: shape.props.h,
          border: "4px solid #000",
          borderRadius: 12,
          overflow: "hidden",
          background: "#fff",
        }}
      >
        <DuckDBStatsPanel />
      </HTMLContainer>
    );
  }
}
