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
  // A local CTE isn't an upstream canvas node. Its name becomes visible after
  // its definition (inside it as well for WITH RECURSIVE), until this scope ends.
  const closeParen = new Map<number, number>();
  const stack: number[] = [];
  const scopeEnds: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "(") stack.push(i);
    if (tokens[i] === ")") {
      const open = stack.pop();
      if (open !== undefined) closeParen.set(open, i);
    }
  }
  stack.length = 0;
  for (let i = 0; i < tokens.length; i++) {
    scopeEnds[i] = stack.length ? (closeParen.get(stack[stack.length - 1]) ?? tokens.length) : tokens.length;
    if (tokens[i] === "(") stack.push(i);
    if (tokens[i] === ")") stack.pop();
  }
  const ctes: { name: string; from: number; to: number }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!/^WITH$/i.test(tokens[i])) continue;
    let cursor = i + 1;
    const recursive = /^RECURSIVE$/i.test(tokens[cursor] ?? "");
    if (recursive) cursor++;
    while (cursor < tokens.length) {
      const name = identifier(tokens[cursor++]);
      if (name === null) break;
      if (tokens[cursor] === "(") cursor = (closeParen.get(cursor) ?? tokens.length) + 1;
      if (!/^AS$/i.test(tokens[cursor++] ?? "")) break;
      if (/^NOT$/i.test(tokens[cursor] ?? "")) cursor++;
      if (/^MATERIALIZED$/i.test(tokens[cursor] ?? "")) cursor++;
      const close = tokens[cursor] === "(" ? closeParen.get(cursor) : undefined;
      if (close === undefined) break;
      ctes.push({ name: name.toLowerCase(), from: recursive ? cursor : close + 1, to: scopeEnds[i] });
      cursor = close + 1;
      if (tokens[cursor++] !== ",") break;
    }
  }
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
    const isLocalCTE =
      parts.length === 1 && ctes.some((cte) => cte.name === first.toLowerCase() && index >= cte.from && index < cte.to);
    if (tokens[cursor + 1] !== "(" && !isLocalCTE) tableNames.add(parts.join("."));
  }
  return Array.from(tableNames);
}
