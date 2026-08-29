import type { ColumnStats } from "./column-stats-types";

type ColumnStatsRow = Record<string, any>;

export type ColumnStatsQuerySourceType = string | null | undefined;

export interface ColumnStatsQuery {
  analysisType: ColumnStats["type"];
  sql: string;
}

export function getColumnAnalysisType(colType: string): ColumnStats["type"] {
  const upperType = colType.toUpperCase();

  const isComplex =
    upperType.includes("STRUCT") ||
    upperType.includes("LIST") ||
    upperType.includes("MAP") ||
    upperType.includes("[]") ||
    upperType.includes("JSON");

  const isNumeric =
    !isComplex &&
    (upperType.includes("INT") ||
      upperType.includes("DOUBLE") ||
      upperType.includes("FLOAT") ||
      upperType.includes("DECIMAL") ||
      upperType.includes("REAL"));

  if (isNumeric) {
    return "numeric";
  }

  const isText =
    !isComplex &&
    (upperType.includes("CHAR") ||
      upperType.includes("STRING") ||
      upperType.includes("TEXT") ||
      upperType.includes("BOOLEAN"));

  if (isText) {
    return "text";
  }

  const isTemporal =
    !isComplex && (upperType.includes("DATE") || upperType.includes("TIMESTAMP") || upperType.includes("TIME"));

  if (isTemporal) {
    return "temporal";
  }

  return "other";
}

export function getColumnAnalysisSteps(analysisType: ColumnStats["type"]): string[] {
  switch (analysisType) {
    case "numeric":
      return ["Min and max", "Distinct count", "Null rate", "Distribution histogram"];
    case "temporal":
      return ["Min and max", "Distinct count", "Null rate", "Time distribution histogram"];
    case "text":
      return ["Distinct count", "Null rate", "Top values"];
    case "other":
    default:
      return ["Distinct count", "Null rate"];
  }
}

export function buildColumnStatsQuery(options: {
  quotedTable: string;
  quotedColumn: string;
  columnType: string;
  sourceType?: ColumnStatsQuerySourceType;
}): ColumnStatsQuery {
  const analysisType = getColumnAnalysisType(options.columnType);

  switch (analysisType) {
    case "numeric":
      return {
        analysisType,
        sql: buildNumericStatsQuery(options.quotedTable, options.quotedColumn, options.sourceType),
      };
    case "temporal":
      return {
        analysisType,
        sql: buildTemporalStatsQuery(options.quotedTable, options.quotedColumn, options.sourceType),
      };
    case "text":
      return { analysisType, sql: buildTextStatsQuery(options.quotedTable, options.quotedColumn) };
    case "other":
    default:
      return { analysisType, sql: buildOtherStatsQuery(options.quotedTable, options.quotedColumn) };
  }
}

export function parseColumnStatsRows(analysisType: ColumnStats["type"], rows: ColumnStatsRow[]): ColumnStats {
  if (rows.length === 0) {
    throw new Error("Column stats query returned no rows");
  }

  switch (analysisType) {
    case "numeric":
      return parseNumericStats(rows);
    case "temporal":
      return parseTemporalStats(rows);
    case "text":
      return parseTextStats(rows);
    case "other":
    default:
      return parseOtherStats(rows[0]);
  }
}

function buildNumericStatsQuery(
  quotedTable: string,
  quotedColumn: string,
  sourceType: ColumnStatsQuerySourceType
): string {
  const histColumn = `t.${quotedColumn}`;
  const histColumnDouble = doubleExpression(histColumn, sourceType);
  const minDouble = doubleExpression("s.min_val", sourceType);
  const maxDouble = doubleExpression("s.max_val", sourceType);

  return `
    WITH stats AS (
      SELECT
        MIN(${quotedColumn}) as min_val,
        MAX(${quotedColumn}) as max_val,
        COUNT(${quotedColumn}) as non_null_count,
        COUNT(DISTINCT ${quotedColumn}) as distinct_count,
        COUNT(*) as total_count
      FROM ${quotedTable}
    ),
    hist AS (
      SELECT
        LEAST(
          CAST(FLOOR((${histColumnDouble} - ${minDouble}) / ((${maxDouble} - ${minDouble}) / 15)) AS INTEGER) + 1,
          15
        ) as bucket,
        COUNT(*) as cnt
      FROM ${quotedTable} t, stats s
      WHERE ${histColumn} IS NOT NULL AND s.min_val < s.max_val
      GROUP BY s.min_val, s.max_val, bucket
    )
    SELECT s.min_val, s.max_val, s.non_null_count, s.distinct_count, s.total_count, h.bucket, h.cnt
    FROM stats s LEFT JOIN hist h ON true
    ORDER BY h.bucket NULLS LAST
  `;
}

function buildTemporalStatsQuery(
  quotedTable: string,
  quotedColumn: string,
  sourceType: ColumnStatsQuerySourceType
): string {
  const histColumn = `t.${quotedColumn}`;
  const columnEpochExpr = temporalEpochExpression(histColumn, sourceType);
  const columnEpochDouble = doubleExpression(columnEpochExpr, sourceType);
  const minEpochDouble = doubleExpression("s.min_epoch", sourceType);
  const maxEpochDouble = doubleExpression("s.max_epoch", sourceType);
  const minEpochExpr = temporalEpochExpression(`MIN(${quotedColumn})`, sourceType);
  const maxEpochExpr = temporalEpochExpression(`MAX(${quotedColumn})`, sourceType);

  return `
    WITH stats_base AS (
      SELECT
        MIN(${quotedColumn}) as min_val,
        MAX(${quotedColumn}) as max_val,
        ${minEpochExpr} as min_epoch,
        ${maxEpochExpr} as max_epoch,
        COUNT(${quotedColumn}) as non_null_count,
        COUNT(DISTINCT ${quotedColumn}) as distinct_count,
        COUNT(*) as total_count
      FROM ${quotedTable}
    ),
    stats AS (
      SELECT
        *,
        CASE
          WHEN min_epoch IS NULL OR max_epoch IS NULL OR min_epoch >= max_epoch THEN 15
          WHEN max_epoch - min_epoch <= 3600 THEN LEAST(60, CAST(CEIL((max_epoch - min_epoch) / 60) AS INTEGER))
          WHEN max_epoch - min_epoch <= 86400 THEN 96
          WHEN max_epoch - min_epoch <= 2592000 THEN 30
          WHEN max_epoch - min_epoch <= 31536000 THEN 52
          ELSE 60
        END as bucket_count
      FROM stats_base
    ),
    hist AS (
      SELECT
        LEAST(
          CAST(FLOOR((${columnEpochDouble} - ${minEpochDouble}) / ((${maxEpochDouble} - ${minEpochDouble}) / s.bucket_count)) AS INTEGER) + 1,
          s.bucket_count
        ) as bucket,
        COUNT(*) as cnt
      FROM ${quotedTable} t, stats s
      WHERE ${histColumn} IS NOT NULL AND s.min_epoch < s.max_epoch
      GROUP BY s.min_epoch, s.max_epoch, s.bucket_count, bucket
    )
    SELECT
      s.min_val,
      s.max_val,
      s.min_epoch,
      s.max_epoch,
      s.non_null_count,
      s.distinct_count,
      s.total_count,
      s.bucket_count,
      h.bucket,
      h.cnt
    FROM stats s LEFT JOIN hist h ON true
    ORDER BY h.bucket NULLS LAST
  `;
}

function buildTextStatsQuery(quotedTable: string, quotedColumn: string): string {
  return `
    WITH top_vals AS (
      SELECT ${quotedColumn} as val, COUNT(*) as cnt
      FROM ${quotedTable}
      GROUP BY ${quotedColumn}
      ORDER BY cnt DESC
      LIMIT 5
    ),
    agg AS (
      SELECT
        COUNT(${quotedColumn}) as non_null_count,
        COUNT(DISTINCT ${quotedColumn}) as distinct_count,
        COUNT(*) as total_count
      FROM ${quotedTable}
    )
    SELECT tv.val, tv.cnt, a.non_null_count, a.distinct_count, a.total_count
    FROM agg a LEFT JOIN top_vals tv ON true
    ORDER BY tv.cnt DESC NULLS LAST
  `;
}

function buildOtherStatsQuery(quotedTable: string, quotedColumn: string): string {
  return `
    SELECT
      COUNT(${quotedColumn}) as non_null_count,
      COUNT(DISTINCT ${quotedColumn}) as distinct_count,
      COUNT(*) as total_count
    FROM ${quotedTable}
  `;
}

function temporalEpochExpression(expr: string, sourceType: ColumnStatsQuerySourceType): string {
  if (sourceType === "postgres") {
    return `EXTRACT(EPOCH FROM ${expr})`;
  }
  return `epoch(${expr})`;
}

function doubleExpression(expr: string, sourceType: ColumnStatsQuerySourceType): string {
  if (sourceType === "postgres") {
    return `CAST(${expr} AS DOUBLE PRECISION)`;
  }
  return `CAST(${expr} AS DOUBLE)`;
}

function parseNumericStats(rows: ColumnStatsRow[]): ColumnStats {
  const row = rows[0];
  const counts = parseCounts(row);
  const histogram = buildFixedWidthHistogram(rows, row.min_val, row.max_val, 15, false);

  return {
    type: "numeric",
    min: row.min_val,
    max: row.max_val,
    distinctCount: counts.distinctCount,
    nullCount: counts.nullCount,
    nullPercentage: counts.nullPercentage,
    histogram,
  };
}

function parseTemporalStats(rows: ColumnStatsRow[]): ColumnStats {
  const row = rows[0];
  const counts = parseCounts(row);
  const bucketCount = Number(row.bucket_count ?? 15);
  const histogram = buildFixedWidthHistogram(rows, row.min_epoch, row.max_epoch, bucketCount, true);

  return {
    type: "temporal",
    min: row.min_val,
    max: row.max_val,
    distinctCount: counts.distinctCount,
    nullCount: counts.nullCount,
    nullPercentage: counts.nullPercentage,
    histogram,
  };
}

function parseTextStats(rows: ColumnStatsRow[]): ColumnStats {
  const firstRow = rows[0];
  const counts = parseCounts(firstRow);

  const topRows = rows
    .filter((row) => row.cnt !== null && row.cnt !== undefined)
    .map((row) => ({
      value: row.val,
      count: Number(row.cnt),
    }));

  let topValues: ColumnStats["topValues"] = topRows;
  if (topRows.length === 5) {
    const top4 = topRows.slice(0, 4);
    const top4Sum = top4.reduce((sum, row) => sum + row.count, 0);
    const otherCount = counts.total - top4Sum;
    topValues = otherCount > 0 ? [...top4, { value: "Other", count: otherCount, isOther: true }] : top4;
  }

  return {
    type: "text",
    topValues,
    distinctCount: counts.distinctCount,
    nullCount: counts.nullCount,
    nullPercentage: counts.nullPercentage,
  };
}

function parseOtherStats(row: ColumnStatsRow): ColumnStats {
  const counts = parseCounts(row);
  return {
    type: "other",
    distinctCount: counts.distinctCount,
    nullCount: counts.nullCount,
    nullPercentage: counts.nullPercentage,
  };
}

function parseCounts(row: ColumnStatsRow): {
  total: number;
  nonNull: number;
  distinctCount: number;
  nullCount: number;
  nullPercentage: number;
} {
  const total = Number(row.total_count);
  const nonNull = Number(row.non_null_count);
  const distinctCount = Number(row.distinct_count);
  const nullCount = total - nonNull;
  const nullPercentage = total > 0 ? (nullCount / total) * 100 : 0;

  return { total, nonNull, distinctCount, nullCount, nullPercentage };
}

function buildFixedWidthHistogram(
  rows: ColumnStatsRow[],
  rawMin: any,
  rawMax: any,
  bucketCount: number,
  epochMilliseconds: boolean
): { bin: number; count: number; start: number; end: number }[] {
  const min = Number(rawMin);
  const max = Number(rawMax);

  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max || bucketCount <= 0) {
    return [];
  }

  const bucketWidth = (max - min) / bucketCount;
  const histData = rows
    .filter((row) => row.bucket !== null && row.bucket !== undefined)
    .map((row) => ({ bucket: Number(row.bucket), count: Number(row.cnt) }));

  const histogram: { bin: number; count: number; start: number; end: number }[] = [];
  for (let i = 1; i <= bucketCount; i++) {
    const existing = histData.find((row) => row.bucket === i);
    const binStart = min + (i - 1) * bucketWidth;
    const binEnd = min + i * bucketWidth;
    histogram.push({
      bin: i,
      count: existing ? existing.count : 0,
      start: epochMilliseconds ? binStart * 1000 : binStart,
      end: epochMilliseconds ? binEnd * 1000 : binEnd,
    });
  }

  return histogram;
}
