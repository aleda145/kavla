import { analyzeQuery } from "@polyglot-sql/sdk";

export function extractTableNames(sql: string): string[] {
  // Physical dependencies exclude CTE aliases, comments and string literals.
  // Incomplete editor text has no executable dependency graph yet.
  const result = analyzeQuery(sql, "duckdb");
  if (!result.success || !result.analysis) return [];
  return Array.from(new Set(result.analysis.baseTables.map(table =>
    !table.catalog && !table.schema ? table.table ?? table.name : table.name
  )));
}
