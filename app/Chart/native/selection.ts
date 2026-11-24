import { quoteSqlString } from "../../src/duckdb/sql.ts";

// Analytical coordinates, shared by SQL and every renderer. Never use rendered
// row IDs as the authoritative selection, including when the plot shows bins.
export type Point = { x: number; y: number };
export type Axis = { field: string; type: "linear" | "log"; domain: [number, number] };
export type OutlineStyle = {
  color: string;
  width: number;
  opacity: number;
  dash: "draw" | "solid" | "dashed" | "dotted";
};
export type BarKey = [category: string | null, group: string | null];
export type SeriesSelection =
  | { kind: "line" | "scatter"; xKind: "number" | "time" }
  | { kind: "line" | "scatter"; xKind: "category"; categories: (string | null)[] }
  | { kind: "bar"; color: string | null; stacked: boolean; keys: BarKey[] };

export type ChartSelection = ({ version: 1; series?: undefined } | { version: 2; series: SeriesSelection }) & {
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
  inverted?: boolean;
  groupName?: string;
  // Present when the chart owns the stroke. drawingId is provenance only;
  // older saved selections may still refer to a standalone canvas drawing.
  outline?: OutlineStyle;
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
  return normalizedSQL(axis, `CAST(${identifier(qualifier)}.${identifier(axis.field)} AS DOUBLE)`);
}

function normalizedSQL(axis: Axis, value: string): string {
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
  if (!hasSelectableArea(polygon)) throw new Error("The outline has no selectable area.");
  return polygon;
}

export function hasSelectableArea(polygon: Point[]): boolean {
  if (polygon.length < 3) return false;
  const a = polygon[0];
  // A trimmed crossing can land almost exactly on the next sampled vertex.
  // Use a long baseline so two nearby samples don't make a full loop look collinear.
  let b = a;
  let longest = 0;
  for (const p of polygon) {
    const squared = (p.x - a.x) ** 2 + (p.y - a.y) ** 2;
    if (squared > longest) {
      longest = squared;
      b = p;
    }
  }
  return polygon.some((p) => Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) > boundaryEpsilon);
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

export function selectsPoint(point: Point, region: Pick<ChartSelection, "polygon" | "inverted">): boolean {
  return (
    point.x >= 0 &&
    point.x <= 1 &&
    point.y >= 0 &&
    point.y <= 1 &&
    containsPoint(point, region.polygon) !== Boolean(region.inverted)
  );
}

type SelectionGeometry = Pick<ChartSelection, "x" | "y" | "polygon" | "inverted">;
const sqlKey = (key: string | null) => (key === null ? "NULL::VARCHAR" : quoteSqlString(key));

export function chartValueSQL(field: string, kind: "number" | "time"): string {
  return kind === "time" ? `epoch_ms(TRY_CAST(${field} AS TIMESTAMP))` : `TRY_CAST(${field} AS DOUBLE)`;
}

type SQLRegion = SelectionGeometry & { series?: SeriesSelection; groupName?: string };

export function selectionSQL(sourceSQL: string, area: SQLRegion | SQLRegion[]): string {
  return drawingRowsSQL(sourceSQL, Array.isArray(area) ? area : [area], false);
}

export function clusteredRowsSQL(sourceSQL: string, regions: SQLRegion[]): string {
  return drawingRowsSQL(
    sourceSQL,
    regions.filter((region) => region.groupName),
    true
  );
}

function drawingRowsSQL(sourceSQL: string, regions: SQLRegion[], grouped: boolean): string {
  const input = `(${sourceSQL.trim().replace(/;+\s*$/, "")})`;
  function project(columns: string, from: string, predicates: string[]) {
    if (!grouped) return `SELECT ${columns} FROM ${from} WHERE ${predicates.join(" OR ") || "FALSE"}`;
    const cases = predicates.map((predicate, i) => `WHEN ${predicate} THEN ${quoteSqlString(regions[i].groupName!)}`);
    const cluster = cases.length ? `CASE ${cases.join("\n")} ELSE NULL END` : "NULL::VARCHAR";
    // Put the label first so DuckDB disambiguates an existing input column called cluster.
    return `SELECT ${cluster} AS cluster, ${columns} FROM ${from}`;
  }
  let from = `${input} AS observation`;
  if (!regions.length) return project("observation.*", from, []);
  // Every outline is bound to the same plot and visible category page.
  const { series, x, y } = regions[0];
  if (!series)
    return project(
      "observation.*",
      from,
      regions.map((r) => selectionPredicate(r))
    );
  const field = identifier(x.field);
  if (series.kind === "bar") {
    const category = `CAST(numbered.original_row.${field} AS VARCHAR)`;
    const group =
      series.color === null ? "NULL::VARCHAR" : `CAST(numbered.original_row.${identifier(series.color)} AS VARCHAR)`;
    const numbered = `(SELECT struct_pack(*COLUMNS(*)) AS original_row, row_number() OVER () AS ord FROM ${input} AS src) AS numbered`;
    const rank = `row_number() OVER (PARTITION BY ${category}, ${group} ORDER BY numbered.ord)`;
    const finite = `isfinite(TRY_CAST(numbered.original_row.${identifier(y.field)} AS DOUBLE))`;
    function barHit(keys: Set<string>) {
      if (!keys.size) return "FALSE";
      return `EXISTS (SELECT 1 FROM (VALUES ${[...keys].join(", ")}) AS hit(category, series)
        WHERE hit.category IS NOT DISTINCT FROM ${category} AND hit.series IS NOT DISTINCT FROM ${group})`;
    }
    const keys = regions.map((region) => {
      if (region.series?.kind !== "bar") throw new Error("Expected a bar selection.");
      return region.series.keys.map(([category, group]) => `(${sqlKey(category)}, ${sqlKey(group)})`);
    });
    if (!grouped) {
      return `SELECT original_row.* FROM (SELECT numbered.original_row FROM ${numbered}
        WHERE ${barHit(new Set(keys.flat()))} QUALIFY ${rank} = 1) AS chosen
        WHERE isfinite(TRY_CAST(chosen.original_row.${identifier(y.field)} AS DOUBLE))`;
    }
    // A bar represents the first source row for its key. Keep duplicates in the output with a NULL label.
    const ranked = `(SELECT numbered.*, ${rank} AS bar_rank FROM ${numbered}) AS numbered`;
    const predicates = keys.map((hits) => `bar_rank = 1 AND ${finite} AND ${barHit(new Set(hits))}`);
    return project("original_row.*", ranked, predicates) + " ORDER BY numbered.ord";
  }

  let xValue: string;
  if (series.xKind === "category") {
    if (!series.categories.length) return project("observation.*", from, []);
    const offset = x.domain[0] + 0.5;
    const values = series.categories.map((key, i) => `(${sqlKey(key)}, ${literal(offset + i)})`).join(", ");
    from += ` ${grouped ? "LEFT JOIN" : "JOIN"} (VALUES ${values}) AS visible_category(label, position)
      ON visible_category.label IS NOT DISTINCT FROM CAST(observation.${field} AS VARCHAR)`;
    xValue = "visible_category.position";
  } else {
    xValue = chartValueSQL(`observation.${field}`, series.xKind);
  }
  const yValue = chartValueSQL(`observation.${identifier(y.field)}`, "number");
  const predicates = regions.map((r) => selectionPredicate(r, normalizedSQL(x, xValue), normalizedSQL(y, yValue)));
  return project("observation.*", from, predicates);
}

// Custom Mosaic clients can reuse this predicate with an "observation" alias.
// Polygon metadata intentionally does not pretend to be an interval index.
export function selectionPredicate(
  selection: SelectionGeometry,
  xCoordinate = coordinateSQL(selection.x),
  yCoordinate = coordinateSQL(selection.y)
): string {
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
  FROM (SELECT ${xCoordinate} AS px,
               ${yCoordinate} AS py) AS point
  WHERE isfinite(px) AND isfinite(py)
    -- Only observations visible in the selected analytical domain qualify.
    AND px BETWEEN 0 AND 1 AND py BETWEEN 0 AND 1
    AND ${selection.inverted ? "NOT " : ""}(
      px BETWEEN ${literal(Math.min(...xs) - boundaryEpsilon)} AND ${literal(Math.max(...xs) + boundaryEpsilon)}
      AND py BETWEEN ${literal(Math.min(...ys) - boundaryEpsilon)} AND ${literal(Math.max(...ys) + boundaryEpsilon)}
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
    )
)`;
}

export function readSelection(value: unknown): ChartSelection | null {
  if (typeof value !== "string") return null;
  return validateSelection(JSON.parse(value));
}

export function readSelections(value: unknown): ChartSelection[] {
  if (typeof value !== "string") return [];
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.map(validateSelection) : [validateSelection(parsed)];
}

export function serializeSelections(regions: ChartSelection[]) {
  if (!regions.length) return null;
  return JSON.stringify(regions.length === 1 ? regions[0] : regions);
}

function validateSelection(s: ChartSelection): ChartSelection {
  if (
    !s ||
    (s.version !== 1 && s.version !== 2) ||
    (s.version === 1 && s.series !== undefined) ||
    (s.version === 2 && !validSeries(s.series)) ||
    s.semantics !== "observations" ||
    s.policy !== "live" ||
    typeof s.sourceRevision !== "string" ||
    typeof s.sourceSQL !== "string" ||
    typeof s.sourceId !== "string" ||
    typeof s.drawingId !== "string" ||
    typeof s.chartId !== "string" ||
    (s.groupName !== undefined && (typeof s.groupName !== "string" || !s.groupName.trim())) ||
    (s.inverted !== undefined && typeof s.inverted !== "boolean") ||
    ![s.x, s.y].every(
      (axis) =>
        axis &&
        typeof axis.field === "string" &&
        ["linear", "log"].includes(axis.type) &&
        Array.isArray(axis.domain) &&
        axis.domain.length === 2 &&
        axis.domain.every((n) => Number.isFinite(n) && (axis.type !== "log" || n > 0)) &&
        axis.domain[0] !== axis.domain[1]
    ) ||
    !Array.isArray(s.polygon)
  )
    throw new Error("This saved selection is not supported.");
  s.polygon = validatePolygon(s.polygon);
  if (
    s.outline &&
    (typeof s.outline.color !== "string" ||
      !Number.isFinite(s.outline.width) ||
      s.outline.width <= 0 ||
      !Number.isFinite(s.outline.opacity) ||
      s.outline.opacity < 0 ||
      s.outline.opacity > 1 ||
      !["draw", "solid", "dashed", "dotted"].includes(s.outline.dash))
  )
    throw new Error("This saved chart outline is not supported.");
  coordinateSQL(s.x);
  coordinateSQL(s.y);
  return s;
}

function validSeries(series: SeriesSelection | undefined): boolean {
  const isKey = (key: unknown) => key === null || typeof key === "string";
  if (series?.kind === "bar") {
    return (
      isKey(series.color) &&
      typeof series.stacked === "boolean" &&
      Array.isArray(series.keys) &&
      series.keys.every((key) => Array.isArray(key) && key.length === 2 && key.every(isKey))
    );
  }
  return (
    (series?.kind === "line" || series?.kind === "scatter") &&
    (series.xKind === "time" ||
      series.xKind === "number" ||
      (series.xKind === "category" && Array.isArray(series.categories) && series.categories.every(isKey)))
  );
}
