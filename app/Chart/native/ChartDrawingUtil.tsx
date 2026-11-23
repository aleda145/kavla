import { DrawShapeUtil, type TLDrawShape } from "tldraw";
import { CircleAlert } from "lucide-react";

export class ChartDrawingUtil extends DrawShapeUtil {
  override component(shape: TLDrawShape) {
    const stroke = super.component(shape);
    const error = shape.meta.nativeLassoError;
    const tip = shape.props.segments.at(-1)?.points.at(-1);
    if (typeof error !== "string" || !tip) return stroke;
    return (
      <>
        {stroke}
        <span
          className="kavla-chart__drawing-warning"
          style={{ left: tip.x + 6, top: tip.y + 6 }}
          role="status"
          title={error}
          aria-label={`No selection. ${error}`}
        >
          <CircleAlert size={13} aria-hidden /> No selection
        </span>
      </>
    );
  }
}
