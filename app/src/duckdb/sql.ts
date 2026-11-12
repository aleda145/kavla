import { Dialect, tokenize } from "@polyglot-sql/sdk";

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

export function stripSQLComments(sql: string): string {
  // The tokenizer uses Unicode character offsets, rather than JS string offsets.
  const characters = Array.from(sql);
  // Normalize CR for tokenization only; keep the original SQL and line endings below.
  const result = tokenize(sql.replaceAll("\r", "\n"), Dialect.DuckDB);
  if (!result.success || !result.tokens) throw new Error(result.error || "Could not tokenize SQL.");

  const output = characters.map((char) => (char === "\r" || char === "\n" ? char : " ".repeat(char.length)));
  // Comments are attached as metadata, so only restore the actual SQL token ranges.
  for (const { span } of result.tokens) {
    for (let index = span.start; index < span.end; index++) output[index] = characters[index];
  }
  return output.join("");
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
