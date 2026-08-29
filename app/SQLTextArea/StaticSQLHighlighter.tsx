import { highlightTree } from "@lezer/highlight";
import { defaultHighlightStyle } from "@codemirror/language";
import React, { memo, useMemo } from "react";
import { getColumnTypeMutedColor } from "../util/column-colors";
import { DuckDBDialect } from "./duckdb-dialect";
import {
  createSqlNameLookup,
  findMentionedTables,
  getRelevantColumns,
  scanSqlIdentifiers,
  shouldSuppressColumn,
  type SqlColumnDefinition,
} from "./sql-identifiers";

const parser = DuckDBDialect.language.parser;

interface StaticSQLHighlighterProps {
  sql: string;
  validTableNames?: Set<string>;
  sources?: Set<string>;
  queries?: Set<string>;
  columnMapping?: Record<string, SqlColumnDefinition[]>;
  upstreamTableNames?: string[];
}

export const StaticSQLHighlighter = memo(
  ({ sql, validTableNames, sources, queries, columnMapping, upstreamTableNames }: StaticSQLHighlighterProps) => {
    const spansByLine = useMemo(() => {
      const tableNames = createSqlNameLookup(validTableNames ?? []);
      const mentionedTables = findMentionedTables(sql, tableNames);
      const upstreamTables = new Set(upstreamTableNames ?? []);
      const tree = parser.parse(sql);
      const tokens: { from: number; to: number; classes?: string }[] = [];
      let pos = 0;

      highlightTree(tree, defaultHighlightStyle, (from, to, classes) => {
        if (from > pos) {
          tokens.push({ from: pos, to: from, classes: undefined });
        }
        tokens.push({ from, to, classes });
        pos = to;
      });

      if (pos < sql.length) {
        tokens.push({ from: pos, to: sql.length, classes: undefined });
      }

      const lines = sql.split("\n");
      let currentGlobalPos = 0;
      let tokenIndex = 0;

      return lines.map((lineText) => {
        const lineStart = currentGlobalPos;
        const lineEnd = currentGlobalPos + lineText.length;
        currentGlobalPos = lineEnd + 1;

        const lineNodes: React.ReactNode[] = [];

        while (tokenIndex < tokens.length) {
          const token = tokens[tokenIndex];

          if (token.to <= lineStart) {
            tokenIndex++;
            continue;
          }

          if (token.from >= lineEnd) {
            break;
          }

          const intersectionStart = Math.max(token.from, lineStart);
          const intersectionEnd = Math.min(token.to, lineEnd);

          if (intersectionStart < intersectionEnd) {
            const textPart = sql.slice(intersectionStart, intersectionEnd);

            // Parser styling takes precedence inside literals and comments so their
            // contents are not mistaken for schema identifiers.
            const isSafe =
              token.classes &&
              (token.classes.includes("string") ||
                token.classes.includes("comment") ||
                token.classes.includes("number"));

            if (token.classes && isSafe) {
              lineNodes.push(
                <span key={intersectionStart} className={token.classes} style={{ fontFamily: "monospace" }}>
                  {textPart}
                </span>
              );
            } else {
              const highlighted = renderWithHighlights(
                textPart,
                intersectionStart,
                tableNames,
                sources,
                queries,
                columnMapping,
                upstreamTables,
                mentionedTables,
                sql
              );

              const mergedNodes = highlighted.map((node, _i) => {
                if (React.isValidElement(node) && token.classes) {
                  const element = node as React.ReactElement<{ className?: string }>;
                  const existingClass = element.props.className || "";
                  const newClass = `${existingClass} ${token.classes}`.trim();
                  return React.cloneElement(element, { className: newClass });
                }
                return node;
              });

              lineNodes.push(...mergedNodes);
            }
          }

          // Leave a multi-line token active for the next line.
          if (token.to > lineEnd) {
            break;
          } else {
            tokenIndex++;
          }
        }

        if (lineNodes.length === 0) {
          lineNodes.push(<span key={lineStart}> </span>);
        }

        return lineNodes;
      });
    }, [sql, validTableNames, sources, queries, columnMapping, upstreamTableNames]);

    const lineCount = spansByLine.length;
    // Match CodeMirror's gutter padding while allowing for every line-number digit.
    const gutterWidth = `calc(${String(lineCount).length}ch + 11px)`;

    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          overflow: "hidden",
          backgroundColor: "#fff",
          color: "#000",
          fontFamily: "monospace",
          fontSize: 14,
          lineHeight: 1.43,
          display: "flex",
          flexDirection: "column",
          borderBottomLeftRadius: "inherit",
        }}
      >
        <div style={{ display: "flex", flexDirection: "row", minHeight: "2px" }}>
          <div
            style={{
              minWidth: gutterWidth,
              backgroundColor: "#f5f5f5",
              borderRight: "1px solid #ddd",
              marginRight: "4px",
            }}
          />
          <div style={{ flex: 1 }} />
        </div>
        {spansByLine.map((lineContent, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "row" }}>
            <div
              style={{
                minWidth: gutterWidth,
                textAlign: "right",
                paddingRight: "3px",
                color: "gray",
                backgroundColor: "#f5f5f5",
                borderRight: "1px solid #ddd",
                userSelect: "none",
                marginRight: "4px",
              }}
            >
              {i + 1}
            </div>
            <div
              style={{
                flex: 1,
                whiteSpace: "pre",
                paddingLeft: "4px",
              }}
            >
              {lineContent}
            </div>
          </div>
        ))}
        <div style={{ flex: 1, display: "flex", flexDirection: "row", borderBottomLeftRadius: "inherit" }}>
          <div
            style={{
              minWidth: gutterWidth,
              backgroundColor: "#f5f5f5",
              borderRight: "1px solid #ddd",
              marginRight: "4px",
              borderBottomLeftRadius: "inherit",
            }}
          />
          <div
            style={{
              flex: 1,
            }}
          />
        </div>
      </div>
    );
  }
);

const renderWithHighlights = (
  text: string,
  keyOffset: number,
  tableNames: Map<string, string>,
  sources?: Set<string>,
  queries?: Set<string>,
  columnMapping?: Record<string, SqlColumnDefinition[]>,
  upstreamTableNames?: ReadonlySet<string>,
  mentionedTables?: ReadonlySet<string>,
  fullSql?: string
) => {
  const hasTables = tableNames.size > 0;
  const hasColumns = columnMapping && Object.keys(columnMapping).length > 0;

  if (!hasTables && !hasColumns) {
    return [<span key={keyOffset}>{text}</span>];
  }

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  const contextSql = fullSql ?? text;
  const contextOffset = fullSql ? keyOffset : 0;

  for (const identifier of scanSqlIdentifiers(text)) {
    const globalIdentifier = {
      ...identifier,
      from: contextOffset + identifier.from,
      to: contextOffset + identifier.to,
    };
    const tableName = tableNames.get(identifier.name.toLowerCase());
    const columnMatches =
      !shouldSuppressColumn(contextSql, globalIdentifier) && columnMapping
        ? columnMapping[identifier.name.toLowerCase()]
        : undefined;

    if (tableName) {
      if (identifier.from > lastIndex) {
        parts.push(<span key={keyOffset + lastIndex}>{text.slice(lastIndex, identifier.from)}</span>);
      }

      let style = {
        fontFamily: "monospace",
        backgroundColor: "rgba(59, 130, 246, 0.1)",
        borderBottom: "2px solid #3b82f6",
      };

      if (queries?.has(tableName)) {
        style = {
          fontFamily: "monospace",
          backgroundColor: "#fef9c3",
          borderBottom: "2px solid #ca8a04",
        };
      } else if (sources?.has(tableName)) {
        // Source tables use the default blue style.
      }

      parts.push(
        <span key={keyOffset + identifier.from} style={style}>
          {text.slice(identifier.from, identifier.to)}
        </span>
      );

      lastIndex = identifier.to;
    } else if (columnMatches && columnMatches.length > 0) {
      if (identifier.from > lastIndex) {
        parts.push(<span key={keyOffset + lastIndex}>{text.slice(lastIndex, identifier.from)}</span>);
      }

      const prioritizedDef = getRelevantColumns(
        columnMatches,
        upstreamTableNames ?? new Set(),
        mentionedTables ?? new Set()
      )[0];
      const type = prioritizedDef.type;
      const colorClass = getColumnTypeMutedColor(type);

      parts.push(
        <span
          key={keyOffset + identifier.from}
          className={`${colorClass} rounded-none text-black`}
          style={{ fontFamily: "monospace" }}
        >
          {text.slice(identifier.from, identifier.to)}
        </span>
      );

      lastIndex = identifier.to;
    }
  }

  if (lastIndex < text.length) {
    parts.push(<span key={keyOffset + lastIndex}>{text.slice(lastIndex)}</span>);
  }

  if (parts.length === 0) return [<span key={keyOffset}>{text}</span>];
  return parts;
};
