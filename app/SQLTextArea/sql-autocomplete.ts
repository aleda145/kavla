import { autocompletion, CompletionContext, CompletionSource } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { DuckDBService } from "../src/duckdb-service";
import { quoteIdentifier, quoteSqlString } from "../src/duckdb/sql";
import {
  createSqlNameLookup,
  findMentionedTables,
  isAliasDeclaration,
  type SqlColumnDefinition,
} from "./sql-identifiers";

function getStringLiteralCompletionText(value: string, typedQuote: string): string {
  if (typedQuote === "'") {
    return `${value.replace(/'/g, "''")}'`;
  }
  if (typedQuote === '"') {
    return `${value.replace(/"/g, '""')}"`;
  }
  return quoteSqlString(value);
}

export const createSqlAutocomplete = (
  uniqueTableNames: Set<string>,
  allColumns: SqlColumnDefinition[],
  upstreamTableNames: string[] = []
) => {
  const tableNames = createSqlNameLookup(uniqueTableNames);

  return autocompletion({
    override: [
      async (context: CompletionContext) => {
        const dotMatch = context.matchBefore(/([a-zA-Z_][a-zA-Z0-9_]*)\.[\w_]*/);

        const textBeforeForValues = context.state.sliceDoc(Math.max(0, context.pos - 50), context.pos);
        const valueMatch = textBeforeForValues.match(
          /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*(=|!=|<>|IN\s*\()\s*(['"]?)([\w_]*)$/i
        );

        if (valueMatch) {
          const columnName = valueMatch[1];
          const hasQuote = valueMatch[3];
          const partialValue = valueMatch[4];

          const textFull = context.state.doc.toString();
          const relevantTablesForValues = new Set<string>(upstreamTableNames);
          for (const tableName of findMentionedTables(textFull, tableNames)) {
            relevantTablesForValues.add(tableName);
          }

          const col = allColumns.find(
            (c) => c.name.toLowerCase() === columnName.toLowerCase() && relevantTablesForValues.has(c.tableName)
          );

          if (col) {
            try {
              const stats = await DuckDBService.getInstance().getColumnStats(col.tableName, col.name, col.type);
              const distinctCount = stats?.distinctCount ?? 0;

              if (stats && distinctCount > 0 && distinctCount <= 10) {
                let optionsData: any[] = [];

                if (stats.type === "text" && stats.topValues) {
                  optionsData = stats.topValues.filter((v: any) => !v.isOther);
                } else if (stats.type === "numeric" || stats.type === "temporal") {
                  // Numeric and temporal profiles contain buckets, not exact
                  // values, so fetch values only for low-cardinality columns.
                  const db = DuckDBService.getInstance().getDb();
                  if (db) {
                    const conn = await db.connect();
                    try {
                      const quotedColumn = quoteIdentifier(col.name);
                      const quotedTable = quoteIdentifier(col.tableName);
                      const topRes = await conn.query(
                        `SELECT ${quotedColumn} as val, COUNT(*) as cnt FROM ${quotedTable} WHERE ${quotedColumn} IS NOT NULL GROUP BY ${quotedColumn} ORDER BY cnt DESC LIMIT 10`
                      );
                      optionsData = topRes.toArray().map((r: any) => {
                        const row = r.toJSON();
                        return {
                          value: String(row.val),
                          count: Number(row.cnt),
                        };
                      });
                    } catch (e) {
                      console.error("Autocomplete exact numeric query error:", e);
                    } finally {
                      await conn.close();
                    }
                  }
                }

                if (optionsData.length > 0) {
                  const isTextType =
                    col.type.toLowerCase().includes("char") ||
                    col.type.toLowerCase().includes("string") ||
                    col.type.toLowerCase().includes("text");

                  const options = optionsData.map((r: any) => {
                    const valRaw = String(r.value);
                    let applyText = valRaw;

                    if (isTextType) {
                      applyText = getStringLiteralCompletionText(valRaw, hasQuote);
                    }

                    return {
                      label: valRaw,
                      type: "constant",
                      detail: `Count: ${r.count}`,
                      apply: applyText,
                      boost: Number(r.count),
                    };
                  });

                  return {
                    from: context.pos - partialValue.length,
                    options: options,
                    validFor: /^[\w_]*$/,
                  };
                }
              }
            } catch (e) {
              console.error("Autocomplete value query error:", e);
            }
          }
        }

        if (dotMatch) {
          const parts = dotMatch.text.split(".");

          if (parts.length === 2) {
            const tableNameRaw = parts[0];

            const matchedTableName = tableNames.get(tableNameRaw.toLowerCase());

            if (matchedTableName) {
              const relevantCols = allColumns.filter((col) => col.tableName === matchedTableName);

              return {
                from: dotMatch.from + tableNameRaw.length + 1,
                options: relevantCols.map((col) => ({
                  label: col.name,
                  type: "property",
                  detail: col.type,
                  boost: 1,
                })),
                validFor: /^[\w_]*$/,
              };
            }
          }
        }

        const word = context.matchBefore(/[\w_]*/);
        if (!word || (word.from === word.to && !context.explicit)) return null;

        const text = context.state.doc.toString();
        if (isAliasDeclaration(text, word.from)) {
          return null;
        }

        const relevantTables = new Set<string>(upstreamTableNames);
        for (const tableName of findMentionedTables(text, tableNames)) {
          relevantTables.add(tableName);
        }

        let node = syntaxTree(context.state).resolveInner(context.pos, -1);

        let inSelect = false;
        let inFrom = false;
        let inWhereLike = false;
        let inFunction = false;

        let currentNode: any = node;
        while (currentNode) {
          const name = currentNode.name;
          if (name === "Select") inSelect = true;
          if (name === "FromClause" || name === "JoinClause") inFrom = true;
          if (
            name === "WhereClause" ||
            name === "HavingClause" ||
            name === "GroupClause" ||
            name === "OrderClause" ||
            name === "LimitClause"
          )
            inWhereLike = true;
          if (name === "ArgList" || name === "Parens" || name === "Call" || name === "Function" || name === "CallExpr")
            inFunction = true;

          if (name === "Statement" || name === "Script") break;
          currentNode = currentNode.parent;
        }

        // In incomplete SQL the syntax tree may not identify the current clause.
        if (!inFrom && !inSelect && !inWhereLike) {
          const textBefore = context.state.sliceDoc(0, word.from);
          const matches = [...textBefore.matchAll(/\b(SELECT|FROM|JOIN|WHERE|HAVING|GROUP|ORDER|LIMIT)\b/gi)];
          if (matches.length > 0) {
            const lastKeyword = matches[matches.length - 1][0].toUpperCase();
            if (lastKeyword === "FROM" || lastKeyword === "JOIN") {
              inFrom = true;
            } else if (["WHERE", "HAVING", "GROUP", "ORDER", "LIMIT"].includes(lastKeyword)) {
              inWhereLike = true;
            } else if (lastKeyword === "SELECT") {
              inSelect = true;
            }
          }
        }

        const textBeforeWord = context.state.sliceDoc(0, word.from);
        if (/[\w_]+\s*\(\s*$/.test(textBeforeWord)) {
          inFunction = true;
        }

        const isSelectClause = !inFrom && !inWhereLike;

        let standardOptions: any[] = [];

        const sources = context.state.languageDataAt<CompletionSource>("autocomplete", context.pos);
        for (const source of sources) {
          const result = await source(context);
          if (result) {
            standardOptions = standardOptions.concat(result.options);
          }
        }

        let filteredStandardOptions = standardOptions;

        if (inFrom) {
          // Kavla supplies table completions with connection-aware ranking.
          filteredStandardOptions = standardOptions.filter(
            (opt) =>
              opt.type !== "property" &&
              opt.type !== "variable" &&
              opt.type !== "table" &&
              opt.type !== "class" &&
              opt.type !== "schema"
          );
        } else if (isSelectClause || inWhereLike) {
          filteredStandardOptions = standardOptions.filter(
            (opt) =>
              opt.type !== "class" &&
              opt.type !== "table" &&
              opt.type !== "schema" &&
              opt.type !== "property" &&
              opt.type !== "variable"
          );
        }

        let customOptions: any[] = [];

        if (inFrom) {
          const upstreamSet = new Set(upstreamTableNames);
          const tableOpts = Array.from(uniqueTableNames).map((t) => {
            const isUpstream = upstreamSet.has(t);
            return {
              label: t,
              type: "table",
              detail: isUpstream ? "Connected Source" : "Available Source",
              boost: isUpstream ? 2 : 1,
            };
          });
          customOptions = tableOpts.sort((a, b) => b.boost - a.boost);
        }

        if (isSelectClause || inWhereLike) {
          const shouldAddComma = isSelectClause && !inFunction;
          const colOptions = allColumns
            .filter((col) => relevantTables.has(col.tableName))
            .map((col) => {
              const applyText = /\s/.test(col.name) ? `"${col.name}"` : col.name;
              return {
                label: col.name,
                type: "property",
                detail: col.tableName,
                boost: 0,
                apply: shouldAddComma ? `${applyText}, ` : applyText,
              };
            });
          customOptions = colOptions;
        }

        return {
          from: word.from,
          options: [...filteredStandardOptions, ...customOptions],
          validFor: /^[\w_]*$/,
        };
      },
    ],
  });
};
