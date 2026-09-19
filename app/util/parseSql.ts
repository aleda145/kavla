export function extractTableNames(sql: string): string[] {
  // Keep quoted identifiers and string literals intact so their contents cannot
  // be mistaken for FROM/JOIN clauses. Comments may separate a clause and name.
  const tokens = Array.from(
    sql.matchAll(
      /--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|[a-zA-Z_][a-zA-Z0-9_$]*|[^\s]/g
    ),
    (match) => match[0]
  ).filter((token) => !token.startsWith("--") && !token.startsWith("/*"));
  const identifier = (token: string | undefined): string | null => {
    if (!token) return null;
    if (token.startsWith('"')) return token.slice(1, -1).replace(/""/g, '"');
    if (token.startsWith("`")) return token.slice(1, -1).replace(/``/g, "`");
    return /^[a-zA-Z_][a-zA-Z0-9_$]*$/.test(token) ? token : null;
  };
  const tableNames = new Set<string>();
  for (let index = 0; index < tokens.length; index++) {
    if (!/^(FROM|JOIN)$/i.test(tokens[index])) continue;
    let cursor = index + 1;
    if (/^LATERAL$/i.test(tokens[cursor] ?? "")) cursor++;
    const first = identifier(tokens[cursor]);
    if (first === null) continue;
    const parts = [first];
    while (tokens[cursor + 1] === ".") {
      const part = identifier(tokens[cursor + 2]);
      if (part === null) break;
      parts.push(part);
      cursor += 2;
    }
    // Table functions aren't canvas tables. Keep scanning their arguments for subqueries.
    if (tokens[cursor + 1] !== "(") tableNames.add(parts.join("."));
  }
  return Array.from(tableNames);
}
