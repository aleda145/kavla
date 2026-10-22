import type { ChartShape } from "../chart-shape-types";
import { domain, pointBudget, type ScatterPlan } from "./planner.ts";
import { coordinateSQL, identifier, normalize, type Axis } from "./selection.ts";
import type { Mark } from "./ScatterMarks";

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
  categories: { value: number; label: string }[];
  groups: (string | null)[];
  stacked: boolean;
  reduced: boolean;
  page: { offset: number; size: number; total: number } | null;
};
export type ChartQuery = (sql: string) => PromiseLike<{ numRows: number; toArray(): Record<string, unknown>[] }>;
export const isNumericColumn = (type: string) =>
  /^(U?INT|U?BIGINT|HUGEINT|SMALLINT|TINYINT|FLOAT|DOUBLE|REAL|DECIMAL|NUMERIC)/i.test(type);
export function xKindFor(field: string, type: string, kind: ChartKind): XKind {
  if (kind === "bar") return "category";
  if (/^(DATE|TIMESTAMP|DATETIME)/i.test(type)) return "time";
  if (isNumericColumn(type)) return "number";
  if (/(date|timestamp|created_at|updated_at)/i.test(field)) return "time";
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
  const valueX = xKind === "time" ? `epoch_ms(TRY_CAST(${rawX} AS TIMESTAMP))` : `TRY_CAST(${rawX} AS DOUBLE)`;
  const group = props.color ? `CAST(s.${identifier(props.color)} AS VARCHAR)` : "NULL::VARCHAR";
  const base = `WITH input AS (SELECT * FROM (${source.sql})${limit}),
    raw AS (SELECT row_number() OVER () AS ord, CAST(${rawX} AS VARCHAR) AS label_x,
      CAST(${rawY} AS VARCHAR) AS label_y, ${valueX} AS value_x, TRY_CAST(${rawY} AS DOUBLE) AS vy, ${group} AS g FROM input s),
    categories AS (SELECT label_x, min(ord) AS first_ord FROM raw GROUP BY label_x),
    category_ids AS (SELECT *, row_number() OVER (ORDER BY first_ord)-1 AS cid FROM categories),
    positioned AS (SELECT raw.*, ${xKind === "category" ? "cid" : "value_x"} AS vx FROM raw
      ${xKind === "category" ? "JOIN category_ids USING (label_x)" : ""}
      ${xKind === "category" ? "UNION ALL SELECT raw.*, cid AS vx FROM raw JOIN category_ids ON raw.label_x IS NULL AND category_ids.label_x IS NULL" : ""}),
    ranked AS (SELECT *, row_number() OVER (PARTITION BY vx, g ORDER BY ord) AS duplicate FROM positioned),
    observations AS (SELECT * FROM ranked ${kind === "bar" ? "WHERE duplicate = 1" : ""}),
    baselines AS (SELECT *, ${
      stacked
        ? `coalesce(sum(vy) FILTER (WHERE isfinite(vy)) OVER (
      PARTITION BY vx, duplicate, (vy >= 0) ORDER BY g NULLS FIRST ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)`
        : "0::DOUBLE"
    } AS y0 FROM observations),
    plotted_values AS (SELECT *, vy + ${stacked ? "y0" : "0"} AS yt,
      isfinite(vx) AND isfinite(vy)${xLog ? " AND vx > 0" : ""}${yLog ? " AND vy > 0" : ""} AS eligible FROM baselines),
    runs AS (SELECT *, sum(CASE WHEN eligible THEN 0 ELSE 1 END) OVER (PARTITION BY g ORDER BY ord) AS run FROM plotted_values)`;
  const stats = (
    await query(`${base} SELECT (SELECT count(*) FROM raw) AS total,
    count(*) FILTER (WHERE eligible) AS valid, min(vx) FILTER (WHERE eligible) AS xmin, max(vx) FILTER (WHERE eligible) AS xmax,
    min(least(yt, ${stacked ? "y0" : "yt"})) FILTER (WHERE eligible) AS ymin,
    max(greatest(yt, ${stacked ? "y0" : "yt"})) FILTER (WHERE eligible) AS ymax,
    ${xKind === "category" ? "(SELECT count(*) FROM category_ids)" : "0"} AS categories,
    (SELECT count(*) FROM positioned WHERE NOT (coalesce(isfinite(vx) AND isfinite(vy)${xLog ? " AND vx > 0" : ""}${yLog ? " AND vy > 0" : ""}, false))) AS excluded FROM runs`)
  ).toArray()[0];
  const total = Number(stats.total),
    valid = Number(stats.valid);
  const size = Math.max(12, Math.floor(options.width / (kind === "bar" ? 12 : 6)));
  const categoryCount = Number(stats.categories);
  const offset = Math.max(
    0,
    Math.min(Math.floor(options.offset / size) * size, Math.floor(Math.max(0, categoryCount - 1) / size) * size)
  );
  const page = xKind === "category" ? { offset, size, total: categoryCount } : null;
  const categories =
    xKind === "category"
      ? (
          await query(`${base} SELECT cid, label_x FROM category_ids
    WHERE cid >= ${offset} AND cid < ${offset + size} ORDER BY cid`)
        )
          .toArray()
          .map((r) => ({ value: Number(r.cid), label: r.label_x === null ? "(null)" : String(r.label_x) }))
      : [];
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
  const includeZero =
    !yLog && (props.yAxisScale === "zero" || (props.yAxisScale === "default" && (kind === "bar" || kind === "area")));
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
  const columns = Math.max(1, Math.min(256, Math.floor(options.width / 4)));
  const rows = Math.max(1, Math.min(256, Math.floor(options.height / 4)));
  const density = kind === "scatter" && valid > pointBudget;
  const normalizedX = coordinateSQL({ ...x, field: "vx" }, "v"),
    normalizedY = coordinateSQL({ ...y, field: "yt" }, "v");
  const visible = `${base}, visible AS (SELECT *, ${normalizedX} AS nx, ${normalizedY} AS ny FROM runs v
    WHERE eligible ${page ? `AND vx >= ${offset} AND vx < ${offset + size}` : ""})`;
  let sql: string;
  if (density) {
    sql = `${visible}, cells AS (SELECT least(${columns - 1}, greatest(0, floor(nx*${columns}))) AS bin_x,
      least(${rows - 1}, greatest(0, floor(ny*${rows}))) AS bin_y, g, count(*) AS n,
      bool_or(nx < -1e-12 OR nx > 1+1e-12 OR ny < -1e-12 OR ny > 1+1e-12) AS domain_changed FROM visible GROUP BY bin_x, bin_y, g)
      SELECT (bin_x+0.5)/${columns} AS nx, (bin_y+0.5)/${rows} AS ny, sum(n) AS count,
      CAST(to_json(list(struct_pack(key := g, count := n) ORDER BY g NULLS FIRST)) AS VARCHAR) AS groups,
      bool_or(domain_changed) AS domain_changed FROM cells GROUP BY bin_x, bin_y`;
  } else if ((kind === "line" || kind === "area") && valid > pointBudget) {
    // Preserve source order, null-separated runs, and first/last/min/max of both
    // boundaries per horizontal pixel. Stacked areas must retain their baseline.
    const pixels = Math.max(1, Math.floor(options.width));
    sql = `${visible}, binned AS (SELECT *, floor(nx*${pixels}) AS bin FROM visible),
      extrema AS (SELECT *,
        row_number() OVER (PARTITION BY g, run, bin ORDER BY ord) AS first_in_bin,
        row_number() OVER (PARTITION BY g, run, bin ORDER BY ord DESC) AS last_in_bin,
        row_number() OVER (PARTITION BY g, run, bin ORDER BY yt, ord) AS min_in_bin,
        row_number() OVER (PARTITION BY g, run, bin ORDER BY yt DESC, ord) AS max_in_bin,
        row_number() OVER (PARTITION BY g, run, bin ORDER BY y0, ord) AS min_base,
        row_number() OVER (PARTITION BY g, run, bin ORDER BY y0 DESC, ord) AS max_base FROM binned)
      SELECT * FROM extrema WHERE first_in_bin=1 OR last_in_bin=1 OR min_in_bin=1 OR max_in_bin=1 OR min_base=1 OR max_base=1 ORDER BY ord`;
  } else sql = `${visible} SELECT * FROM visible ORDER BY ord${kind === "scatter" ? ` LIMIT ${pointBudget + 1}` : ""}`;
  const result = valid ? await query(sql) : null;
  if (!density && kind === "scatter" && result && result.numRows > pointBudget)
    throw new Error("The source changed while plotting. Refresh the chart; no partial result is shown.");
  const plottedRows = result?.toArray() ?? [];
  if (
    plottedRows.some(
      (row) =>
        row.domain_changed ||
        Number(row.nx) < -1e-12 ||
        Number(row.nx) > 1 + 1e-12 ||
        Number(row.ny) < -1e-12 ||
        Number(row.ny) > 1 + 1e-12
    ) ||
    (!page && density && plottedRows.reduce((count, row) => count + Number(row.count), 0) !== valid) ||
    (!page && !density && valid <= pointBudget && plottedRows.length !== valid)
  )
    throw new Error("The source changed while plotting. Refresh to update the chart bounds and counts.");
  const marks: Mark[] =
    plottedRows.map((r) =>
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
            xValue: r.label_x === null ? "(null)" : String(r.label_x),
            yValue: r.label_y === null ? "(null)" : String(r.label_y),
            group: r.g === null ? null : String(r.g),
            run: Number(r.run),
            y0: normalize(yLog ? Math.max(y.domain[0], Number(r.y0)) : Number(r.y0), y),
          }
    ) ?? [];
  const groups = props.color
    ? Array.from(new Set(marks.flatMap((mark) => mark.groups?.map((g) => g.key) ?? [mark.group ?? null]))).sort(
        (a, b) => String(a).localeCompare(String(b))
      )
    : [];
  return {
    x,
    y,
    marks,
    plan: { sql, mode: density ? "density" : "points", columns, rows },
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
