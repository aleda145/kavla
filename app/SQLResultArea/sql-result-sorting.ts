export type SQLResultSort = { columnName: string; direction: "asc" | "desc" };

type SQLToken = { text: string; from: number; to: number; depth: number };

function readOrderBy(sql: string) {
  const tokens: SQLToken[] = [];
  const comments: SQLToken[] = [];
  let depth = 0;
  // Keep literals, identifiers, knobs, and comments out of clause detection.
  const pattern =
    /--[^\r\n]*|\/\*|\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$|\b[Ee]'(?:\\[\s\S]|''|[^'])*'|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_$]*|\d+|[^\s]/g;
  for (let match = pattern.exec(sql); match; match = pattern.exec(sql)) {
    let text = match[0];
    if (text === "/*") {
      let nesting = 1;
      let end = pattern.lastIndex;
      while (end < sql.length && nesting > 0) {
        if (sql.startsWith("/*", end)) {
          nesting++;
          end += 2;
        } else if (sql.startsWith("*/", end)) {
          nesting--;
          end += 2;
        } else end++;
      }
      text = sql.slice(match.index, end);
      pattern.lastIndex = end;
    }
    const token = { text, from: match.index, to: pattern.lastIndex, depth };
    if (text.startsWith("--") || text.startsWith("/*")) {
      comments.push(token);
      continue;
    }
    tokens.push(token);
    if (text === "(" || text === "[") depth++;
    if (text === ")" || text === "]") depth--;
  }

  const topLevel = tokens.filter((token) => token.depth === 0);
  const terminator = topLevel.find((token) => token.text === ";");
  const isSingleQuery =
    /^(SELECT|WITH|FROM|VALUES|TABLE)$/i.test(topLevel[0]?.text ?? "") &&
    (!terminator || tokens[tokens.length - 1] === terminator) &&
    depth === 0;
  const orderIndex = topLevel.findIndex(
    (token, index) => /^ORDER$/i.test(token.text) && /^BY$/i.test(topLevel[index + 1]?.text ?? "")
  );
  const order = topLevel[orderIndex];
  const suffix = topLevel.find(
    (token, index) => index > orderIndex && /^(LIMIT|OFFSET|FETCH|FOR|;)$/i.test(token.text)
  );
  const end = suffix?.from ?? tokens[tokens.length - 1]?.to ?? 0;
  const expressions = order
    ? tokens.filter((token) => token.from >= topLevel[orderIndex + 1].to && token.from < end)
    : [];
  return { order, end, expressions, comments, isSingleQuery, tokens };
}

function isUnnamedResultColumn(
  tokens: SQLToken[],
  columnName: string,
  columnIndex: number,
  columnCount: number
): boolean {
  const selectIndex = tokens.findIndex((token) => token.depth === 0 && /^SELECT$/i.test(token.text));
  if (selectIndex < 0) return false;
  const projections: SQLToken[][] = [[]];
  for (const token of tokens.slice(selectIndex + 1)) {
    if (
      token.depth === 0 &&
      /^(FROM|WHERE|GROUP|HAVING|QUALIFY|WINDOW|ORDER|LIMIT|OFFSET|FETCH|UNION|EXCEPT|INTERSECT|;)$/i.test(token.text)
    )
      break;
    if (token.depth === 0 && token.text === ",") projections.push([]);
    else projections[projections.length - 1].push(token);
  }

  // A wildcard expands to named source columns. Account for its width when
  // locating an unnamed expression before or after it in the SELECT list.
  const wildcardIndexes = projections.flatMap((projection, index) =>
    projection.some(
      (token, tokenIndex) =>
        token.depth === 0 &&
        token.text === "*" &&
        (tokenIndex === 0 ||
          projection[tokenIndex - 1].text === "." ||
          /^(DISTINCT|ALL)$/i.test(projection[tokenIndex - 1].text))
    )
      ? [index]
      : []
  );
  let projectionIndex = columnIndex;
  if (wildcardIndexes.length === 1) {
    const wildcardIndex = wildcardIndexes[0];
    const wildcardWidth = columnCount - projections.length + 1;
    if (columnIndex >= wildcardIndex && columnIndex < wildcardIndex + wildcardWidth) return false;
    if (columnIndex >= wildcardIndex + wildcardWidth) projectionIndex -= wildcardWidth - 1;
  } else if (wildcardIndexes.length > 1 || projections.length !== columnCount) {
    // Without source schemas, multiple expansions cannot be mapped reliably.
    return false;
  }
  const projection = projections[projectionIndex];
  const firstIndex = /^(DISTINCT|ALL)$/i.test(projection?.[0]?.text ?? "") ? 1 : 0;
  // DuckDB also supports prefix aliases: SELECT total: amount * 2.
  const hasPrefixAlias = projection?.[firstIndex + 1]?.text === ":" && projection?.[firstIndex + 2]?.text !== ":";
  const last = hasPrefixAlias ? projection[firstIndex] : projection?.[projection.length - 1];
  if (!last) return false;
  if (
    !hasPrefixAlias &&
    projection.length - firstIndex === 1 &&
    /^(NULL|TRUE|FALSE|CURRENT_DATE|CURRENT_TIME|CURRENT_TIMESTAMP|CURRENT_USER|LOCALTIME|LOCALTIMESTAMP)$/i.test(
      last.text
    )
  )
    return true;
  // Both column references and explicit/implicit aliases end in an identifier
  // matching the result name. Literals and unnamed calculations do not.
  if (last.depth !== 0 || !/^(?:[A-Za-z_][A-Za-z0-9_$]*|"(?:""|[^"])*"|`(?:``|[^`])*`|'(?:''|[^'])*')$/.test(last.text))
    return true;
  const name = last.text.startsWith('"')
    ? last.text.slice(1, -1).replace(/""/g, '"')
    : last.text.startsWith("`")
      ? last.text.slice(1, -1).replace(/``/g, "`")
      : last.text.startsWith("'")
        ? last.text.slice(1, -1).replace(/''/g, "'")
        : last.text;
  return name.toLowerCase() !== columnName.toLowerCase();
}

export function getSQLResultSort(sql: string, columnNames: string[]): SQLResultSort | null {
  const { expressions, isSingleQuery } = readOrderBy(sql);
  if (!isSingleQuery || expressions.length === 0) return null;
  const parts = expressions.map((token) => token.text);
  if (/^NULLS$/i.test(parts[parts.length - 2] ?? "") && /^(FIRST|LAST)$/i.test(parts[parts.length - 1])) {
    parts.splice(-2);
  }
  let direction: SQLResultSort["direction"] = "asc";
  if (/^(ASC|DESC)$/i.test(parts[parts.length - 1])) {
    direction = parts.pop()!.toLowerCase() as SQLResultSort["direction"];
  }
  // A qualified column is still one sort; expressions and multiple columns are not.
  if (parts.length === 0 || parts.length % 2 === 0) return null;
  for (let index = 0; index < parts.length; index++) {
    if (
      index % 2 === 1
        ? parts[index] !== "."
        : !/^(?:[A-Za-z_][A-Za-z0-9_$]*|"(?:""|[^"])*"|`(?:``|[^`])*`|\d+)$/.test(parts[index])
    )
      return null;
  }
  const identifier = parts[parts.length - 1];
  const name = identifier.startsWith('"')
    ? identifier.slice(1, -1).replace(/""/g, '"')
    : identifier.startsWith("`")
      ? identifier.slice(1, -1).replace(/``/g, "`")
      : identifier;
  const columnName = /^\d+$/.test(identifier)
    ? columnNames[Number(identifier) - 1]
    : columnNames.find((column) => column.toLowerCase() === name.toLowerCase());
  return columnName ? { columnName, direction } : null;
}

export function toggleSQLResultSort(sql: string, columnName: string, columnNames: string[]): string {
  const { order, end, comments, isSingleQuery, tokens } = readOrderBy(sql);
  if (!isSingleQuery) throw new Error("Column sorting requires a single SELECT query.");
  const columnIndex = columnNames.indexOf(columnName);
  if (columnIndex < 0) throw new Error("The selected column is no longer in the query result.");
  const current = getSQLResultSort(sql, columnNames);
  const direction = current?.columnName === columnName ? (current.direction === "desc" ? "asc" : null) : "desc";
  const reference = isUnnamedResultColumn(tokens, columnName, columnIndex, columnNames.length)
    ? String(columnIndex + 1)
    : `"${columnName.replace(/"/g, '""')}"`;
  const clause = direction ? `ORDER BY ${reference} ${direction.toUpperCase()}` : "";
  const start = order?.from ?? end;
  // Retain comments even when replacing the ordering expressions around them.
  const retainedComments = comments.filter((comment) => comment.from >= start && comment.from < end);
  const replacement = [clause, ...retainedComments.map((comment) => comment.text)].filter(Boolean).join("\n");
  return `${sql.slice(0, start).trimEnd()}\n${replacement}${replacement ? "\n" : ""}${sql.slice(end)}`.trimEnd();
}
