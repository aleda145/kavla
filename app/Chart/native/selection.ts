// Analytical coordinates, shared by SQL and every renderer. Never use rendered
// row IDs as the authoritative selection, including when the plot shows bins.
export type Point = { x: number; y: number };
export type Axis = { field: string; type: "linear" | "log"; domain: [number, number] };
export type ScatterSelection = {
  version: 1;
  semantics: "observations";
  policy: "live";
  sourceId: string;
  sourceRevision: string;
  sourceSQL: string;
  chartId: string;
  drawingId: string;
  x: Axis;
  y: Axis;
  polygon: Point[];
};

// Inclusive boundaries in normalized scale space. This is a numerical tolerance,
// not a pixel hit radius. SQL and immediate feedback use the same policy.
export const boundaryEpsilon = 1e-12;
export const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (value: number) => {
  if (!Number.isFinite(value)) throw new Error("Selection coordinates must be finite.");
  return value.toString();
};

export function normalize(value: number, axis: Axis): number {
  const transform = axis.type === "log" ? Math.log : (n: number) => n;
  return (transform(value) - transform(axis.domain[0])) / (transform(axis.domain[1]) - transform(axis.domain[0]));
}

export function coordinateSQL(axis: Axis, qualifier = "observation"): string {
  const value = `CAST(${identifier(qualifier)}.${identifier(axis.field)} AS DOUBLE)`;
  const transform = (n: number) => (axis.type === "log" ? Math.log(n) : n);
  const lo = transform(axis.domain[0]);
  const span = transform(axis.domain[1]) - lo;
  if (!Number.isFinite(span) || span === 0) throw new Error("The axis domain must have finite, distinct endpoints.");
  const expression = axis.type === "log" ? `ln(CASE WHEN ${value} > 0 THEN ${value} END)` : value;
  return `((${expression} - ${literal(lo)}) / ${literal(span)})`;
}

export function validatePolygon(input: Point[]): Point[] {
  const polygon = input.filter((p, i) => !i || p.x !== input[i - 1].x || p.y !== input[i - 1].y);
  if (polygon.length > 1 && polygon[0].x === polygon.at(-1)!.x && polygon[0].y === polygon.at(-1)!.y) polygon.pop();
  if (polygon.length < 3) throw new Error("Draw a closed region with at least three distinct points.");
  if (polygon.length > 512) throw new Error("Selections support at most 512 lasso vertices. Draw a shorter outline.");
  polygon.forEach((p) => {
    literal(p.x);
    literal(p.y);
  });
  // Self intersections have a deliberate even-odd meaning. Reject only fully
  // collinear outlines (signed area alone would reject valid figure eights).
  const a = polygon[0],
    b = polygon[1];
  if (!polygon.some((p) => Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) > boundaryEpsilon))
    throw new Error("The outline has no selectable area.");
  return polygon;
}

export function containsPoint(point: Point, polygon: Point[]): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  let inside = false;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i],
      b = polygon[(i + 1) % polygon.length];
    const dx = b.x - a.x,
      dy = b.y - a.y;
    if (
      Math.abs((point.x - a.x) * dy - (point.y - a.y) * dx) <= boundaryEpsilon * Math.hypot(dx, dy) &&
      point.x >= Math.min(a.x, b.x) - boundaryEpsilon &&
      point.x <= Math.max(a.x, b.x) + boundaryEpsilon &&
      point.y >= Math.min(a.y, b.y) - boundaryEpsilon &&
      point.y <= Math.max(a.y, b.y) + boundaryEpsilon
    )
      return true;
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x)
      inside = !inside;
  }
  return inside;
}

export function selectionSQL(sourceSQL: string, selection: Pick<ScatterSelection, "x" | "y" | "polygon">): string {
  return `SELECT observation.*
FROM (${sourceSQL.trim().replace(/;+\s*$/, "")}) AS observation
WHERE ${selectionPredicate(selection)}`;
}

// Custom Mosaic clients can reuse this predicate with an "observation" alias.
// Polygon metadata intentionally does not pretend to be an interval index.
export function selectionPredicate(selection: Pick<ScatterSelection, "x" | "y" | "polygon">): string {
  const polygon = validatePolygon(selection.polygon);
  const xs = polygon.map((p) => p.x),
    ys = polygon.map((p) => p.y);
  const edges = polygon
    .map((a, i) => {
      const b = polygon[(i + 1) % polygon.length];
      return `(${[a.x, a.y, b.x, b.y].map(literal).join(", ")})`;
    })
    .join(",\n        ");
  // Correlated aliases live in subqueries; no synthetic columns are added to
  // the selected output, even if upstream columns happen to have these names.
  return `EXISTS (
  SELECT 1
  FROM (SELECT ${coordinateSQL(selection.x)} AS px,
               ${coordinateSQL(selection.y)} AS py) AS point
  WHERE isfinite(px) AND isfinite(py)
    AND px BETWEEN ${literal(Math.min(...xs) - boundaryEpsilon)} AND ${literal(Math.max(...xs) + boundaryEpsilon)}
    AND py BETWEEN ${literal(Math.min(...ys) - boundaryEpsilon)} AND ${literal(Math.max(...ys) + boundaryEpsilon)}
    -- Only observations visible in the selected analytical domain qualify.
    AND px BETWEEN 0 AND 1 AND py BETWEEN 0 AND 1
    AND (
      SELECT
        bool_or(
          abs((px-edge_x1)*(edge_y2-edge_y1) - (py-edge_y1)*(edge_x2-edge_x1)) <= ${boundaryEpsilon} * sqrt(pow(edge_x2-edge_x1, 2) + pow(edge_y2-edge_y1, 2))
          AND px BETWEEN least(edge_x1,edge_x2)-${boundaryEpsilon} AND greatest(edge_x1,edge_x2)+${boundaryEpsilon}
          AND py BETWEEN least(edge_y1,edge_y2)-${boundaryEpsilon} AND greatest(edge_y1,edge_y2)+${boundaryEpsilon}
        )
        OR count(*) FILTER (WHERE (edge_y1 > py) <> (edge_y2 > py)
          AND px < (edge_x2-edge_x1)*(py-edge_y1)/nullif(edge_y2-edge_y1,0)+edge_x1) % 2 = 1
      FROM (VALUES
        ${edges}
      ) AS edges(edge_x1, edge_y1, edge_x2, edge_y2)
    )
)`;
}
