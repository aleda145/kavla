export function extractTableNames(sql: string): string[] {
  // This regex finds table names after FROM or JOIN clauses.
  // It's a simple implementation and may not cover all SQL edge cases.
  const regex = /(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;
  const matches = sql.matchAll(regex);
  const tableNames = new Set<string>();
  for (const match of matches) {
    tableNames.add(match[1]);
  }
  return Array.from(tableNames);
}
