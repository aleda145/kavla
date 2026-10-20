import { coordinateSQL, identifier, type Axis } from "./selection.ts";

export const pointBudget = 10000;
export type ScatterPlan = { sql: string; mode: "points" | "density"; columns: number; rows: number };

export function statisticsSQL(source: string, x: string, y: string, xLog = false, yLog = false) {
  return `SELECT count(*) AS total, count(*) FILTER (WHERE ${validCoordinates(xLog, yLog)}) AS valid,
    min(x) FILTER (WHERE ${validCoordinates(xLog, yLog)}) AS xmin,
    max(x) FILTER (WHERE ${validCoordinates(xLog, yLog)}) AS xmax,
    min(y) FILTER (WHERE ${validCoordinates(xLog, yLog)}) AS ymin,
    max(y) FILTER (WHERE ${validCoordinates(xLog, yLog)}) AS ymax
    FROM (SELECT CAST(${identifier(x)} AS DOUBLE) AS x, CAST(${identifier(y)} AS DOUBLE) AS y FROM (${source}) AS source)`;
}

function validCoordinates(xLog: boolean, yLog: boolean) {
  return `isfinite(x) AND isfinite(y)${xLog ? " AND x > 0" : ""}${yLog ? " AND y > 0" : ""}`;
}

export function domain(min: number, max: number, logarithmic = false): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error("No finite observations for these axes.");
  return min === max
    ? logarithmic
      ? [min / 2, min * 2]
      : [min - Math.max(1, Math.abs(min) * 0.01), max + Math.max(1, Math.abs(max) * 0.01)]
    : [min, max];
}

export function planScatter(
  source: string,
  x: Axis,
  y: Axis,
  count: number,
  width: number,
  height: number
): ScatterPlan {
  const columns = Math.max(1, Math.min(128, Math.floor(width / 8)));
  const rows = Math.max(1, Math.min(128, Math.floor(height / 8)));
  const coordinates = `SELECT ${coordinateSQL(x)} AS x, ${coordinateSQL(y)} AS y FROM (${source}) AS observation`;
  const visible = `SELECT * FROM (${coordinates}) WHERE isfinite(x) AND isfinite(y) AND x BETWEEN 0 AND 1 AND y BETWEEN 0 AND 1`;
  if (count <= pointBudget)
    return {
      mode: "points",
      columns,
      rows,
      // LIMIT is a safety check, not sampling: the client rejects overflow. Live
      // sources can grow between the statistics and plot queries.
      sql: `SELECT x, y, 1::BIGINT AS count FROM (${visible}) LIMIT ${pointBudget + 1}`,
    };
  return {
    mode: "density",
    columns,
    rows,
    sql: `SELECT (bin_x+0.5)/${columns} AS x, (bin_y+0.5)/${rows} AS y, count(*) AS count
      FROM (SELECT least(${columns - 1}, floor(x*${columns})) AS bin_x,
                   least(${rows - 1}, floor(y*${rows})) AS bin_y FROM (${visible}))
      GROUP BY bin_x, bin_y`,
  };
}
