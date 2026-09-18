function stripSQLForValidation(sql: string): string {
  // Ignore literals, quoted identifiers, and comments when checking statement keywords.
  return sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|--[^\n\r]*|\/\*[\s\S]*?\*\//g, " ").trim();
}

export function validateReadOnlySQL(value: string): string {
  const sql = value.trim();
  if (!sql) throw new Error("SQL is required.");
  const normalized = stripSQLForValidation(sql).replace(/;+\s*$/, "");
  if (!/^(select|with)\b/i.test(normalized)) {
    throw new Error("The Kavla Agent can only run SELECT or WITH queries.");
  }
  if (normalized.includes(";")) {
    throw new Error("The Kavla Agent can only run one SQL statement at a time.");
  }
  if (/\b(insert|update|delete|drop|create|alter|copy|attach|detach|install|load|call|pragma|export|import)\b/i.test(normalized)) {
    throw new Error("The Kavla Agent cannot run SQL that changes data, files, or DuckDB configuration.");
  }
  return sql.replace(/;+\s*$/, "");
}

