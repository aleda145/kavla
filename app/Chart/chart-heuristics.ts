export type HeuristicResult = {
  x?: string | null;
  y?: string | null;
  color?: string | null;
  chartType?: "scatter" | "line" | "bar" | "area";
  isStacked?: boolean;
};

type ColType = "number" | "date" | "string" | "boolean" | "unknown";

function inferColType(col: string, rows: any[]): ColType {
  const lowerName = col.toLowerCase();

  if (
    ["date", "time", "timestamp", "day", "month", "year", "created_at", "updated_at"].some((k) => lowerName.includes(k))
  ) {
    return "date";
  }
  if (lowerName === "id" || lowerName.endsWith("_id")) {
    return "string";
  }

  for (let i = 0; i < Math.min(rows.length, 50); i++) {
    const val = rows[i][col];
    if (val === null || val === undefined) continue;

    if (typeof val === "number" || typeof val === "bigint") return "number";
    if (typeof val === "boolean") return "boolean";
    if (val instanceof Date) return "date";

    if (typeof val === "string") {
      if (/^\d{4}-\d{2}-\d{2}/.test(val) || /^\d{4}\/\d{2}\/\d{2}/.test(val)) return "date";
      return "string";
    }
  }

  return "unknown";
}

function getUniqueCount(col: string, rows: any[], limit = 100): number {
  const s = new Set();
  for (let i = 0; i < Math.min(rows.length, limit); i++) {
    const val = rows[i][col];
    if (val !== null && val !== undefined) {
      s.add(val);
    }
  }
  return s.size;
}

export function guessChartOptions(data: any[], columns: string[]): HeuristicResult | null {
  if (!data || data.length === 0 || columns.length === 0) return null;

  const colTypes: Record<string, ColType> = {};
  for (const col of columns) {
    colTypes[col] = inferColType(col, data);
  }

  const dateCols = columns.filter((c) => colTypes[c] === "date");
  const numCols = columns.filter((c) => colTypes[c] === "number");
  const catCols = columns.filter((c) => colTypes[c] === "string" || colTypes[c] === "boolean");

  let colorCol: string | null = null;
  for (const col of catCols) {
    const cardinality = getUniqueCount(col, data);
    if (cardinality > 1 && cardinality <= 10) {
      colorCol = col;
      break;
    }
  }

  if (dateCols.length > 0 && numCols.length > 0) {
    return {
      x: dateCols[0],
      y: numCols[0],
      chartType: "line",
      color: colorCol,
    };
  }

  if (numCols.length >= 2) {
    return {
      x: numCols[0],
      y: numCols[1],
      chartType: "scatter",
      color: colorCol,
    };
  }

  if (catCols.length > 0 && numCols.length > 0) {
    let xCol = catCols[0];
    if (catCols.length > 1 && xCol === colorCol) {
      xCol = catCols[1];
    }
    return {
      x: xCol,
      y: numCols[0],
      chartType: "bar",
      color: colorCol === xCol ? null : colorCol,
      isStacked: colorCol !== xCol && !!colorCol,
    };
  }

  return null;
}
