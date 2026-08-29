export type SqlColumnDefinition = {
  tableName: string;
  type: string;
  name: string;
};

export type SqlIdentifier = {
  name: string;
  from: number;
  to: number;
};

export function createSqlNameLookup(names: Iterable<string>): Map<string, string> {
  return new Map(Array.from(names, (name) => [name.toLowerCase(), name]));
}

export function scanSqlIdentifiers(sql: string): SqlIdentifier[] {
  const identifiers: SqlIdentifier[] = [];
  const regex = /"((?:""|[^"])*)"|\b[a-zA-Z_][a-zA-Z0-9_]*\b/g;

  for (const match of sql.matchAll(regex)) {
    const from = match.index;
    identifiers.push({
      name: match[1] === undefined ? match[0] : match[1].replace(/""/g, '"'),
      from,
      to: from + match[0].length,
    });
  }

  return identifiers;
}

export function findSqlIdentifierAt(sql: string, pos: number): SqlIdentifier | null {
  return scanSqlIdentifiers(sql).find(({ from, to }) => from <= pos && pos <= to) ?? null;
}

export function findMentionedTables(sql: string, tableNames: Map<string, string>): Set<string> {
  const found = new Set<string>();

  for (const identifier of scanSqlIdentifiers(sql)) {
    const tableName = tableNames.get(identifier.name.toLowerCase());
    if (tableName) found.add(tableName);
  }

  return found;
}

export function isFunctionCall(sql: string, identifierEnd: number): boolean {
  let next = identifierEnd;
  while (next < sql.length && /\s/.test(sql[next])) next++;
  return sql[next] === "(";
}

export function isAliasDeclaration(sql: string, identifierStart: number): boolean {
  return /(^|[\s(),;])AS\s*$/i.test(sql.slice(Math.max(0, identifierStart - 20), identifierStart));
}

export function shouldSuppressColumn(sql: string, identifier: SqlIdentifier): boolean {
  return isFunctionCall(sql, identifier.to) || isAliasDeclaration(sql, identifier.from);
}

export function getRelevantColumns(
  candidates: SqlColumnDefinition[],
  upstreamTableNames: ReadonlySet<string>,
  mentionedTables: ReadonlySet<string>
): SqlColumnDefinition[] {
  const fromUpstream = candidates.filter((candidate) => upstreamTableNames.has(candidate.tableName));
  if (fromUpstream.length > 0) return fromUpstream;

  const fromSql = candidates.filter((candidate) => mentionedTables.has(candidate.tableName));
  return fromSql.length > 0 ? fromSql : candidates;
}
