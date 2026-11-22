import { bin, extent } from "d3";
import { getColumnAnalysisType } from "../src/duckdb/column-stats-sql";
import type { ColumnStats } from "../src/duckdb/column-stats-types";

export function profileEntryColumn(rows: string[][], column: number, columnType: string): ColumnStats {
  const type = getColumnAnalysisType(columnType);
  const numbers: number[] = [];
  const counts = new Map<string, number>();
  let total = 0;
  let nullCount = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const value = row[column] ?? "";
    if (!value.trim()) {
      // An entirely blank row is omitted when the sheet is saved.
      if (!row.some((cell) => cell.trim())) continue;
      nullCount++;
    } else if (type === "numeric" || type === "temporal") {
      numbers.push(type === "numeric" ? Number(value) : Date.parse(value.trim()));
    } else {
      const key = columnType === "BOOLEAN" ? value.trim().toLowerCase() : value;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    total++;
  }
  const stats: ColumnStats = { type, nullCount, nullPercentage: total ? (100 * nullCount) / total : 0 };
  if (type === "numeric" || type === "temporal") {
    stats.distinctCount = new Set(numbers).size;
    const [min, max] = extent(numbers);
    stats.min = min === undefined ? null : type === "temporal" ? new Date(min).toISOString() : min;
    stats.max = max === undefined ? null : type === "temporal" ? new Date(max).toISOString() : max;
    if (min !== undefined && max !== undefined && Number.isFinite(max - min)) {
      stats.histogram = bin()
        .domain([min, max])
        .thresholds(15)(numbers)
        .map((bucket, index) => ({
          bin: index + 1,
          count: bucket.length,
          start: bucket.x0!,
          end: bucket.x1!,
        }));
    }
  } else {
    stats.distinctCount = counts.size;
    const sorted: { value: string | null; count: number }[] = Array.from(counts, ([value, count]) => ({
      value,
      count,
    }));
    if (nullCount) sorted.push({ value: null, count: nullCount });
    sorted.sort((a, b) => b.count - a.count);
    stats.topValues = sorted.slice(0, 4);
    if (sorted.length > 4) {
      const other = total - stats.topValues.reduce((sum, item) => sum + item.count, 0);
      stats.topValues.push({ value: "Other", count: other, isOther: true });
    }
  }
  return stats;
}
