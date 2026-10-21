import { quadtree } from "d3";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { useValue, type Editor, type TLShapeId } from "tldraw";
import { pointStyle } from "./appearance";
import type { chartGeometry } from "./geometry";
import type { ScatterPlan } from "./planner";
import type { Mark } from "./ScatterMarks";
import type { Point } from "./selection";

const formatRange = (value: number) =>
  Number(value.toPrecision(12)).toLocaleString(undefined, { maximumSignificantDigits: 12 });

export const ScatterTooltip = memo(function ScatterTooltip({
  editor,
  shapeId,
  marks,
  geometry,
  plan,
  width,
  height,
  plotOffset,
  xLabel,
  yLabel,
}: {
  editor: Editor;
  shapeId: TLShapeId;
  marks: Mark[];
  geometry: ReturnType<typeof chartGeometry>;
  plan: ScatterPlan;
  width: number;
  height: number;
  plotOffset: Point;
  xLabel: string;
  yLabel: string;
}) {
  const enabled = useValue("scatter hover enabled", () => editor.isIn("select.idle"), [editor]);
  const view = useValue(
    "scatter hover view",
    () => JSON.stringify([editor.getCamera(), editor.getShapePageBounds(shapeId)]),
    [editor, shapeId]
  );
  // Points use a spatial index; density bins have a direct grid lookup. Neither
  // renderer needs DOM hit testing or a query on each pointer movement.
  const index = useMemo(
    () =>
      plan.mode === "points"
        ? {
            points: quadtree<Mark>()
              .x((mark) => geometry.fromAnalytical(mark).x)
              .y((mark) => geometry.fromAnalytical(mark).y)
              .addAll(marks),
            bins: null,
          }
        : {
            points: null,
            bins: new Map(
              marks.map((mark) => [
                Math.floor(mark.y * plan.rows) * plan.columns + Math.floor(mark.x * plan.columns),
                mark,
              ])
            ),
          },
    [marks, geometry, plan]
  );
  const [hover, setHover] = useState<{ mark: Mark; index: typeof index; view: string } | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [cardSize, setCardSize] = useState({ width: 220, height: 140 });
  const mark = enabled && hover?.index === index && hover.view === view ? hover.mark : null;
  useEffect(() => setHover(null), [enabled, view]);
  useLayoutEffect(() => {
    if (!mark || !tooltipRef.current) return;
    const { offsetWidth: cardWidth, offsetHeight: cardHeight } = tooltipRef.current;
    setCardSize((previous) =>
      previous.width === cardWidth && previous.height === cardHeight
        ? previous
        : { width: cardWidth, height: cardHeight }
    );
  }, [mark, width, height, xLabel, yLabel]);

  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!enabled || event.buttons !== 0 || event.pointerType === "touch") {
      setHover(null);
      return;
    }
    const local = editor.getPointInShapeSpace(shapeId, editor.screenToPage({ x: event.clientX, y: event.clientY }));
    const point = { x: local.x - plotOffset.x, y: local.y - plotOffset.y };
    const analytical = geometry.toAnalytical(point);
    let next: Mark | undefined;
    if (plan.mode === "density") {
      if (analytical.x >= 0 && analytical.x <= 1 && analytical.y >= 0 && analytical.y <= 1) {
        const column = Math.min(plan.columns - 1, Math.floor(analytical.x * plan.columns));
        const row = Math.min(plan.rows - 1, Math.floor(analytical.y * plan.rows));
        next = index.bins?.get(row * plan.columns + column);
      }
    } else {
      const radius = Math.max(pointStyle(marks.length).radius + 2, 6 / editor.getZoomLevel());
      next = index.points?.find(point.x, point.y, radius);
    }
    setHover((previous) =>
      next
        ? previous?.mark === next && previous.index === index && previous.view === view
          ? previous
          : { mark: next, index, view }
        : null
    );
  };

  const anchor = mark ? geometry.fromAnalytical(mark) : { x: 0, y: 0 };
  const left = Math.max(
    8,
    Math.min(
      width - cardSize.width - 8,
      anchor.x + cardSize.width + 20 <= width ? anchor.x + 12 : anchor.x - cardSize.width - 12
    )
  );
  const top = Math.max(8, Math.min(height - cardSize.height - 8, anchor.y - cardSize.height / 2));
  const column = mark ? Math.floor(mark.x * plan.columns) : 0;
  const row = mark ? Math.floor(mark.y * plan.rows) : 0;
  const low = geometry.unproject(geometry.fromAnalytical({ x: column / plan.columns, y: row / plan.rows }));
  const high = geometry.unproject(
    geometry.fromAnalytical({ x: (column + 1) / plan.columns, y: (row + 1) / plan.rows })
  );
  const value = mark ? geometry.unproject(anchor) : null;
  return (
    <div
      style={{ position: "absolute", inset: 0 }}
      onPointerMove={move}
      onPointerLeave={() => setHover(null)}
      onPointerDown={() => setHover(null)}
      onPointerCancel={() => setHover(null)}
    >
      {mark && (
        <>
          <svg
            width={width}
            height={height}
            aria-hidden="true"
            style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
          >
            {plan.mode === "density" ? (
              <rect
                x={anchor.x - geometry.plot.width / plan.columns / 2}
                y={anchor.y - geometry.plot.height / plan.rows / 2}
                width={geometry.plot.width / plan.columns}
                height={geometry.plot.height / plan.rows}
                fill="none"
                stroke="#000"
                strokeWidth={2}
              />
            ) : (
              <circle
                cx={anchor.x}
                cy={anchor.y}
                r={pointStyle(marks.length).radius + 3}
                fill="none"
                stroke="#000"
                strokeWidth={1.5}
              />
            )}
          </svg>
          <div ref={tooltipRef} role="tooltip" className="kavla-scatter__tooltip" style={{ left, top }}>
            <strong>
              {plan.mode === "density"
                ? `${mark.count.toLocaleString()} ${mark.count === 1 ? "row" : "rows"} in bin`
                : "Point"}
            </strong>
            <dl>
              <dt title={xLabel}>{xLabel}</dt>
              <dd>
                {plan.mode === "density"
                  ? `${formatRange(low.x)} – ${formatRange(high.x)}`
                  : (mark.xValue ?? formatRange(value!.x))}
              </dd>
              <dt title={yLabel}>{yLabel}</dt>
              <dd>
                {plan.mode === "density"
                  ? `${formatRange(low.y)} – ${formatRange(high.y)}`
                  : (mark.yValue ?? formatRange(value!.y))}
              </dd>
            </dl>
            {plan.mode === "density" && <p>Axis ranges · approximate bounds</p>}
          </div>
        </>
      )}
    </div>
  );
});
