import { linePath, barBands, type chartGeometry } from "./geometry";
import type { Point } from "./selection";

export function LineMarks({
  runs,
  geometry,
  thin = false,
}: {
  runs: (Point | null)[][];
  geometry: ReturnType<typeof chartGeometry>;
  thin?: boolean;
}) {
  return (
    <g>
      {runs.map((points, i) => (
        <path
          key={i}
          d={linePath(points, geometry.project) ?? undefined}
          fill="none"
          stroke="#3b82f6"
          strokeWidth={thin ? 1 : 3}
        />
      ))}
    </g>
  );
}

export function BarMarks({
  values,
  width,
  projectY,
  baseline,
}: {
  values: { category: string; value: number }[];
  width: number;
  projectY: (value: number) => number;
  baseline: number;
}) {
  const bands = barBands(
    values.map((row) => row.category),
    width
  );
  return (
    <g>
      {values.map((row) => (
        <rect
          key={row.category}
          x={bands(row.category)}
          y={Math.min(baseline, projectY(row.value))}
          width={bands.bandwidth()}
          height={Math.abs(projectY(row.value) - baseline)}
          fill="#3b82f6"
        />
      ))}
    </g>
  );
}
