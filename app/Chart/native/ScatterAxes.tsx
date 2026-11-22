import type { chartGeometry } from "./geometry";
import type { Point } from "./selection";
import { memo } from "react";

export const ScatterAxes = memo(function ScatterAxes({
  geometry,
  width,
  height,
  xLabel,
  yLabel,
  polygon,
}: {
  geometry: ReturnType<typeof chartGeometry>;
  width: number;
  height: number;
  xLabel: string;
  yLabel: string;
  polygon: Point[] | null;
}) {
  return (
    <svg width={width} height={height} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <path
        d={`M${geometry.plot.left},${geometry.plot.top}V${geometry.plot.top + geometry.plot.height}H${geometry.plot.left + geometry.plot.width}`}
        fill="none"
        stroke="black"
        strokeWidth={2}
      />
      {geometry.xScale.ticks(Math.max(2, Math.floor(width / 110))).map((t) => (
        <text
          key={t}
          x={geometry.xScale(t)}
          y={geometry.plot.top + geometry.plot.height + 20}
          textAnchor="middle"
          fontSize={11}
        >
          {geometry.xScale.tickFormat(5)(t)}
        </text>
      ))}
      {geometry.yScale.ticks(Math.max(2, Math.floor(height / 65))).map((t) => (
        <text key={t} x={geometry.plot.left - 8} y={geometry.yScale(t) + 4} textAnchor="end" fontSize={11}>
          {geometry.yScale.tickFormat(5)(t)}
        </text>
      ))}
      <text x={width / 2} y={height - 4} fontSize={12} textAnchor="middle">
        {xLabel}
      </text>
      <text transform={`translate(13,${height / 2}) rotate(-90)`} fontSize={12} textAnchor="middle">
        {yLabel}
      </text>
      {polygon && (
        <polygon
          points={polygon
            .map((p) => {
              const q = geometry.fromAnalytical(p);
              return `${q.x},${q.y}`;
            })
            .join(" ")}
          fill="#eab308"
          fillOpacity={0.1}
          fillRule="evenodd"
          stroke="#a16207"
          strokeWidth={1.5}
        />
      )}
    </svg>
  );
});
