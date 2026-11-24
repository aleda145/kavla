import { Query, column, m4, verbatim } from "@uwdata/mosaic-sql";
import { identifier } from "./selection.ts";

// Focused follow-on prototypes, not yet enabled in saved charts.
// M4 preserves first/last/min/max within each pixel bin. Each run must already
// exclude nulls and have a distinct run key so gaps are never connected.
export function planLineRun(
  sourceSQL: string,
  x: string,
  y: string,
  run: string,
  minX: number,
  maxX: number,
  pixels: number
) {
  if (!Number.isFinite(minX) || !Number.isFinite(maxX) || maxX <= minX || !Number.isFinite(pixels) || pixels < 1)
    throw new Error("Line reduction requires a finite increasing domain and positive pixel width.");
  const input = Query.from(verbatim(`(${sourceSQL}) AS line_input`)).select(x, y, run);
  const bin = verbatim(`(CAST(${identifier(x)} AS DOUBLE) - ${minX}) / ${maxX - minX} * ${Math.floor(pixels)}`);
  return m4(input, bin, x, y, [column(run)]);
}

export function planBars(sourceSQL: string, category: string, value: string, maxCategories = 100) {
  // One extra category is a sentinel. The caller must reject overflow, or
  // explicitly present a top-k/Other view with contributor lineage.
  return `SELECT ${identifier(category)} AS category, sum(${identifier(value)}) AS value
    FROM (${sourceSQL}) AS bar_input GROUP BY ${identifier(category)}
    ORDER BY category LIMIT ${Math.max(1, Math.floor(maxCategories)) + 1}`;
}
