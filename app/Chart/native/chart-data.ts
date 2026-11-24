import type { ChartShape } from "../chart-shape-types";
import { domain, pointBudget, type ScatterPlan } from "./planner.ts";
import { chartValueSQL, identifier, normalize, type Axis } from "./selection.ts";
import type { Mark } from "./ScatterMarks";
import { Query, bin2d, column, count, m4, verbatim } from "@uwdata/mosaic-sql";

export type ChartKind = "scatter" | "line" | "area" | "bar";
export type XKind = "number" | "time" | "category";
export type ChartData = {
  x: Axis;
  y: Axis;
  marks: Mark[];
  plan: ScatterPlan;
  total: number;
  valid: number;
  excluded: number;
  kind: ChartKind;
  xKind: XKind;
  categories: { value: number; label: string; key: string | null }[];
  groups: (string | null)[];
  stacked: boolean;
  reduced: boolean;
  page: { offset: number; size: number; total: number } | null;
};
export type ChartQuery = (sql: Query) => PromiseLike<{ numRows: number; toArray(): Record<string, unknown>[] }>;
export const isNumericColumn = (type: string) =>
  /^(U?INT|U?BIGINT|HUGEINT|SMALLINT|TINYINT|FLOAT|DOUBLE|REAL|DECIMAL|NUMERIC)/i.test(type);
export function xKindFor(field: string, type: string, kind: ChartKind): XKind {
  if (kind === "bar") return "category";
  if (/^(DATE|TIMESTAMP|DATETIME)/i.test(type)) return "time";
  if (isNumericColumn(type)) return "number";
  if (!type && /(date|timestamp|created_at|updated_at)/i.test(field)) return "time";
  return "category";
}

export async function loadChartData(
  query: ChartQuery,
  source: { sql: string; schema: { name: string; type: string }[] },
  props: ChartShape["props"],
  options: { xLog: boolean; yLog: boolean; width: number; height: number; offset: number }
): Promise<ChartData> {
  const kind = props.chartType ?? "scatter";
  if (!["scatter", "line", "area", "bar"].includes(kind))
    throw new Error(`Unsupported chart type: ${kind}. Choose a chart type in settings.`);
  if (!props.x || !props.y) throw new Error("Choose an X and Y column in chart settings.");
  for (const field of [props.x, props.y, props.color].filter((v): v is string => v !== null)) {
    if (!source.schema.some((column) => column.name === field))
      throw new Error(`Column “${field}” is no longer available. Choose a column in chart settings.`);
  }
  const xKind = xKindFor(props.x, source.schema.find((c) => c.name === props.x)!.type, kind as ChartKind);
  const stacked = Boolean(props.color && props.isStacked && (kind === "bar" || kind === "area"));
  const xLog = options.xLog && xKind === "number",
    yLog = options.yLog && !stacked && kind !== "bar";
  const limit = props.limit === null ? "" : ` LIMIT ${Math.max(1, Math.floor(props.limit))}`;
  if (props.limit !== null && !Number.isFinite(props.limit))
    throw new Error("The saved row limit must be a finite number.");
  const rawX = `s.${identifier(props.x)}`,
    rawY = `s.${identifier(props.y)}`;
  const valueX = chartValueSQL(rawX, xKind === "time" ? "time" : "number");
  const group = props.color ? `CAST(s.${identifier(props.color)} AS VARCHAR)` : "NULL::VARCHAR";
  const eligible = `isfinite(vx) AND isfinite(vy)${xLog ? " AND vx > 0" : ""}${yLog ? " AND vy > 0" : ""}`;
  const base = `WITH input AS (SELECT * FROM (${source.sql})${limit}),
    raw AS MATERIALIZED (SELECT row_number() OVER () AS ord, CAST(${rawX} AS VARCHAR) AS label_x,
      CAST(${rawY} AS VARCHAR) AS label_y, ${valueX} AS value_x, TRY_CAST(${rawY} AS DOUBLE) AS vy, ${group} AS g FROM input s),
    categories AS (SELECT label_x, min(ord) AS first_ord FROM raw GROUP BY label_x),
    category_ids AS (SELECT *, row_number() OVER (ORDER BY first_ord)-1 AS cid FROM categories),
    positioned AS (SELECT raw.*, ${xKind === "category" ? "cid" : "value_x"} AS vx FROM raw
      ${xKind === "category" ? "JOIN category_ids ON raw.label_x IS NOT DISTINCT FROM category_ids.label_x" : ""}),
    ranked AS (SELECT *, ${kind === "bar" || stacked ? "row_number() OVER (PARTITION BY vx, g ORDER BY ord)" : "1"} AS duplicate FROM positioned),
    observations AS (SELECT * FROM ranked ${kind === "bar" ? "WHERE duplicate = 1" : ""}),
    baselines AS (SELECT *, ${
      stacked
        ? `coalesce(sum(vy) FILTER (WHERE isfinite(vy)) OVER (
      PARTITION BY vx, duplicate, (vy >= 0) ORDER BY g NULLS FIRST ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)`
        : "0::DOUBLE"
    } AS y0 FROM observations),
    plotted_values AS (SELECT *, vy + ${stacked ? "y0" : "0"} AS yt,
      ${eligible} AS eligible FROM baselines),
    runs AS (SELECT *, ${kind === "line" || kind === "area" ? "sum(CASE WHEN eligible THEN 0 ELSE 1 END) OVER (PARTITION BY g ORDER BY ord)" : "0"} AS run FROM plotted_values)`;
  const size = Math.max(12, Math.floor(options.width / (kind === "bar" ? 12 : 6)));
  const columns = Math.max(1, Math.min(256, Math.floor(options.width / 4)));
  const rows = Math.max(1, Math.min(256, Math.floor(options.height / 4)));
  const includeZero =
    !yLog && (props.yAxisScale === "zero" || (props.yAxisScale === "default" && (kind === "bar" || kind === "area")));
  const categorical = xKind === "category";
  // The result view can contain SAMPLE, LIMIT or volatile expressions. Bounds, category positions,
  // and both rendering plans must read the very same observations, even if a rerun replaces the view.
  // Bars discard duplicate representatives before computing their domains. Count their input separately.
  const totalSQL = kind === "bar" ? "(SELECT count(*) FROM raw)" : "count(*)";
  const excludedSQL =
    kind === "bar"
      ? `(SELECT count(*) FROM positioned WHERE NOT coalesce(${eligible}, false))`
      : "count(*) FILTER (WHERE NOT coalesce(eligible, false))";
  const statsSQL = `SELECT
    ${totalSQL} AS total, count(*) FILTER (WHERE eligible) AS valid,
    min(vx) FILTER (WHERE eligible) AS xmin, max(vx) FILTER (WHERE eligible) AS xmax,
    min(least(yt, ${stacked ? "y0" : "yt"})) FILTER (WHERE eligible) AS ymin,
    max(greatest(yt, ${stacked ? "y0" : "yt"})) FILTER (WHERE eligible) AS ymax,
    ${categorical ? "(SELECT count(*) FROM category_ids)" : "0"} AS category_count,
    ${excludedSQL} AS excluded FROM runs`;
  const offsetSQL = categorical
    ? `least(${Math.max(0, Math.floor(options.offset / size) * size)}, floor(greatest(category_count - 1, 0) / ${size})::BIGINT * ${size})`
    : "0";
  const xlo = categorical ? "page_offset - 0.5" : "xmin";
  const xhi = categorical ? `greatest(page_offset + 0.5, least(category_count, page_offset + ${size}) - 0.5)` : "xmax";
  const ylo = includeZero ? "least(0, ymin)" : "ymin";
  const yhi = includeZero ? "greatest(0, ymax)" : "ymax";
  const coordinate = (field: string, lo: string, hi: string, log: boolean) => {
    const scale = (value: string) =>
      log ? `ln(CASE WHEN ${value} > 0 THEN ${value} END)` : `CAST((${value}) AS DOUBLE)`;
    // domain() expands a constant axis symmetrically in its scale space.
    return `CASE WHEN ${lo} = ${hi} THEN 0.5 ELSE (${scale(field)} - ${scale(lo)}) / (${scale(hi)} - ${scale(lo)}) END`;
  };
  const common = `${base},
    stats AS (${statsSQL}),
    bounds AS (SELECT *, ${offsetSQL} AS page_offset FROM stats),
    visible AS (SELECT v.*, ${coordinate("vx", xlo, xhi, xLog)} AS nx, ${coordinate("yt", ylo, yhi, yLog)} AS ny,
      valid > ${pointBudget} AS large FROM runs v CROSS JOIN bounds WHERE eligible
      ${categorical ? `AND vx >= page_offset AND vx < page_offset + ${size}` : ""})`;

  const markFields = ["ord", "nx", "ny", "label_x", "label_y", "g", "run", "y0"];
  let marksSQL = String(Query.from("visible").select(...markFields));
  if (kind !== "bar") {
    const points = Query.from("visible")
      .select(...markFields)
      .where("NOT large");
    let reduced: Query;
    if (kind === "scatter") {
      const cells = bin2d(
        Query.from("visible").select("g").where("large"),
        verbatim(`least(${columns - 1}, greatest(0, nx*${columns}))`),
        verbatim(`least(${rows - 1}, greatest(0, ny*${rows}))`),
        { n: count() },
        columns,
        ["g"]
      );
      reduced = Query.from({ cells })
        .select({
          nx: verbatim(`((index % ${columns})+0.5)/${columns}`),
          ny: verbatim(`(floor(index / ${columns})+0.5)/${rows}`),
          count: verbatim("sum(n)"),
          groups: verbatim("CAST(to_json(list(struct_pack(key := g, count := n) ORDER BY g NULLS FIRST)) AS VARCHAR)"),
        })
        .groupby("index");
    } else {
      // M4 bins by display X and preserves source order within each color and null-separated run.
      // Stacked areas need the extrema of both the top and the baseline.
      const bin = verbatim(`nx*${Math.max(1, Math.floor(options.width))}`);
      const keys = [column("g"), column("run")];
      const upper = Query.from({ upper: m4("large_line", bin, "ord", "yt", keys) }).select("ord");
      const extrema = stacked
        ? Query.union(upper, Query.from({ lower: m4("large_line", bin, "ord", "y0", keys) }).select("ord"))
        : upper;
      reduced = Query.with({ large_line: Query.from("visible").select("*").where("large") })
        .from("large_line")
        .select(...markFields)
        .where(verbatim(`ord IN (${extrema})`));
    }
    marksSQL = `(${points}) UNION ALL BY NAME (${reduced})`;
  }

  // Separate header and category records keep statistics out of every mark and preserve empty plots.
  const plotSQL = `${common}, marks AS (${marksSQL}),
    chart_rows AS (
      SELECT 0 AS part, * FROM bounds
      ${
        categorical
          ? `UNION ALL BY NAME SELECT 1 AS part, cid AS ord, label_x FROM category_ids CROSS JOIN bounds
        WHERE cid >= page_offset AND cid < page_offset + ${size}`
          : ""
      }
      UNION ALL BY NAME SELECT 2 AS part, * FROM marks)
    SELECT * FROM chart_rows`;
  const plotQuery = Query.from(verbatim(`(${plotSQL}) AS chart_snapshot`))
    .select("*")
    .orderby("part", "ord");
  const records = (await query(plotQuery)).toArray();
  const stats = records[0];
  const total = Number(stats.total);
  const valid = Number(stats.valid);
  const offset = Number(stats.page_offset);
  const page = categorical ? { offset, size, total: Number(stats.category_count) } : null;
  const categories = records
    .filter((r) => Number(r.part) === 1)
    .map((r) => ({
      value: Number(r.ord),
      label: r.label_x === null ? "(null)" : String(r.label_x),
      key: r.label_x === null ? null : String(r.label_x),
    }));
  const plottedRows = records.filter((r) => Number(r.part) === 2);
  const density = kind === "scatter" && valid > pointBudget;
  const x: Axis = {
    field: props.x,
    type: xLog ? "log" : "linear",
    domain:
      xKind === "category"
        ? [offset - 0.5, Math.max(offset + 0.5, offset + categories.length - 0.5)]
        : valid
          ? xKind === "time" && Number(stats.xmin) === Number(stats.xmax)
            ? [Number(stats.xmin) - 43200000, Number(stats.xmax) + 43200000]
            : domain(Number(stats.xmin), Number(stats.xmax), xLog)
          : xLog
            ? [1, 10]
            : [0, 1],
  };
  const y: Axis = {
    field: props.y,
    type: yLog ? "log" : "linear",
    domain: valid
      ? domain(
          includeZero ? Math.min(0, Number(stats.ymin)) : Number(stats.ymin),
          includeZero ? Math.max(0, Number(stats.ymax)) : Number(stats.ymax),
          yLog
        )
      : yLog
        ? [1, 10]
        : [0, 1],
  };
  const marks: Mark[] = plottedRows.map((r) =>
    density
      ? {
          x: Number(r.nx),
          y: Number(r.ny),
          count: Number(r.count),
          ...(props.color ? { groups: JSON.parse(String(r.groups)) as { key: string | null; count: number }[] } : {}),
        }
      : {
          x: Number(r.nx),
          y: Number(r.ny),
          count: 1,
          xValue: r.label_x === null ? null : String(r.label_x),
          yValue: r.label_y === null ? "(null)" : String(r.label_y),
          group: r.g === null ? null : String(r.g),
          run: Number(r.run),
          y0: normalize(yLog ? Math.max(y.domain[0], Number(r.y0)) : Number(r.y0), y),
        }
  );
  const groups = props.color
    ? Array.from(new Set(marks.flatMap((mark) => mark.groups?.map((g) => g.key) ?? [mark.group ?? null]))).sort(
        (a, b) => String(a).localeCompare(String(b))
      )
    : [];
  return {
    x,
    y,
    marks,
    plan: { sql: String(plotQuery), mode: density ? "density" : "points", columns, rows },
    total,
    valid,
    excluded: Number(stats.excluded),
    kind: kind as ChartKind,
    xKind,
    categories,
    groups,
    stacked,
    reduced: density || ((kind === "line" || kind === "area") && valid > pointBudget),
    page,
  };
}
