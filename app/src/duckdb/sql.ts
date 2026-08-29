export function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function quoteDottedIdentifier(value: string): string {
  return value.split(".").map(quoteIdentifier).join(".");
}

export function stripTrailingSemicolons(sql: string): string {
  return sql.trim().replace(/;+\s*$/, "");
}

export function getReadFunction(filename: string): string {
  const lowerCaseFilename = filename.toLowerCase();
  if (lowerCaseFilename.endsWith(".csv")) {
    return "read_csv_auto";
  }
  if (lowerCaseFilename.endsWith(".parquet")) {
    return "read_parquet";
  }
  if (lowerCaseFilename.endsWith(".json")) {
    return "read_json_auto";
  }
  throw new Error(`Unsupported file type for: ${filename}`);
}
