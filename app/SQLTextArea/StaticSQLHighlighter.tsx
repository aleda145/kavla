import { dbtReferenceSignature, getDbtRelationReferences } from "../Dbt/dbtSQL";
import { dbtColors } from "../Dbt/dbtColors";
import { highlightTree } from "@lezer/highlight";
import { defaultHighlightStyle } from "@codemirror/language";
import React, { memo, useMemo } from "react";
import { getColumnTypeMutedColor } from "../util/column-colors";
import { DuckDBDialect } from "./duckdb-dialect";
import { useEditor, useValue } from "tldraw";
import { describeKnob, findKnob, getKnobReferences, navigateToKnob } from "../Knob/knobReferences";
import { dbtMacroSignature, getDbtMacroReferences, navigateToDbtShape } from "../Dbt/dbtMacros";
import {
  createSqlNameLookup,
  findMentionedTables,
  getRelevantColumns,
  scanSqlIdentifiers,
  shouldSuppressColumn,
  type SqlColumnDefinition,
} from "./sql-identifiers";

const parser = DuckDBDialect.language.parser;

export type SQLHighlightTarget =
  | { kind: "column"; column: SqlColumnDefinition }
  | { kind: "table"; tableName: string }
  | { kind: "knob"; name: string };

interface StaticSQLHighlighterProps {
  sql: string;
  inline?: boolean;
  contextSql?: string;
  renderIdentifier?: (content: React.ReactNode, target: SQLHighlightTarget) => React.ReactNode;
  validTableNames?: Set<string>;
  sources?: Set<string>;
  queries?: Set<string>;
  columnMapping?: Record<string, SqlColumnDefinition[]>;
  upstreamTableNames?: string[];
}

export const StaticSQLHighlighter = memo(
  ({
    sql,
    inline = false,
    contextSql,
    renderIdentifier,
    validTableNames,
    sources,
    queries,
    columnMapping,
    upstreamTableNames,
  }: StaticSQLHighlighterProps) => {
    const editor = useEditor();
    const referenceSignature = useValue("static SQL dbt references", () => dbtReferenceSignature(editor), [editor]);
    const macroSignature = useValue("static SQL macro definitions", () => dbtMacroSignature(editor), [editor]);
    const spansByLine = useMemo(() => {
      const tableNames = createSqlNameLookup(validTableNames ?? []);
      const mentionedTables = findMentionedTables(contextSql ?? sql, tableNames);
      const upstreamTables = new Set(upstreamTableNames ?? []);
      const tree = parser.parse(sql);
      let tokens: {
        from: number;
        to: number;
        classes?: string;
        knobName?: string;
        relation?: ReturnType<typeof getDbtRelationReferences>[number];
        macro?: ReturnType<typeof getDbtMacroReferences>[number];
      }[] = [];
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

      for (const reference of getKnobReferences(sql)) {
        tokens = tokens.flatMap((token) => {
          if (token.to <= reference.from || token.from >= reference.to) return [token];
          return [
            ...(token.from < reference.from ? [{ ...token, to: reference.from }] : []),
            ...(token.to > reference.to ? [{ ...token, from: reference.to }] : []),
          ];
        });
        tokens.push({ from: reference.from, to: reference.to, knobName: reference.name });
      }
      for (const macro of getDbtMacroReferences(editor, sql)) {
        tokens = tokens.flatMap((token) => {
          if (token.to <= macro.from || token.from >= macro.to) return [token];
          return [
            ...(token.from < macro.from ? [{ ...token, to: macro.from }] : []),
            ...(token.to > macro.to ? [{ ...token, from: macro.to }] : []),
          ];
        });
        tokens.push({ from: macro.from, to: macro.to, macro });
      }
      for (const relation of getDbtRelationReferences(editor, sql)) {
        tokens = tokens.flatMap((token) => {
          if (token.to <= relation.from || token.from >= relation.to) return [token];
          return [
            ...(token.from < relation.from ? [{ ...token, to: relation.from }] : []),
            ...(token.to > relation.to ? [{ ...token, from: relation.to }] : []),
          ];
        });
        tokens.push({ from: relation.from, to: relation.to, relation });
      }
      tokens.sort((a, b) => a.from - b.from);

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
            const isSafe = /String|Comment|Number/.test(tree.resolveInner(intersectionStart, 1).name);

            if (token.macro || token.relation) {
              const reference = token.macro ?? token.relation!;
              lineNodes.push(
                <span
                  key={intersectionStart}
                  title={
                    token.macro
                      ? `${token.macro.path} · Ctrl/Cmd+click to go to macro`
                      : `${token.relation!.label} · Ctrl/Cmd+click to go to node`
                  }
                  style={{
                    fontFamily: "monospace",
                    ...(token.macro
                      ? {
                          backgroundColor: dbtColors.surface,
                          color: dbtColors.text,
                          borderBottom: `2px solid ${dbtColors.accent}`,
                          fontWeight: 700,
                        }
                      : token.relation?.shapeType === "sql-text-area"
                        ? {
                            backgroundColor: "#fef9c3",
                            borderBottom: "2px solid #ca8a04",
                          }
                        : {
                            backgroundColor: "rgba(59, 130, 246, 0.1)",
                            borderBottom: "2px solid #3b82f6",
                          }),
                  }}
                  onMouseDown={(event) => {
                    if (!event.ctrlKey && !event.metaKey) return;
                    event.preventDefault();
                    event.stopPropagation();
                    navigateToDbtShape(editor, reference.shapeId);
                  }}
                >
                  {textPart}
                </span>
              );
            } else if (token.knobName !== undefined) {
              lineNodes.push(
                <StaticKnobReference key={intersectionStart} name={token.knobName} renderIdentifier={renderIdentifier}>
                  {textPart}
                </StaticKnobReference>
              );
            } else if (token.classes && isSafe) {
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
                sql,
                renderIdentifier
              );

              const mergedNodes = highlighted.map((node, _i) => {
                if (React.isValidElement(node) && node.type !== React.Fragment && token.classes) {
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
    }, [
      sql,
      contextSql,
      renderIdentifier,
      validTableNames,
      sources,
      queries,
      columnMapping,
      upstreamTableNames,
      editor,
      macroSignature,
      referenceSignature,
    ]);

    if (inline) {
      return (
        <span style={{ fontFamily: "monospace", color: "#000" }}>
          <style>{defaultHighlightStyle.module?.getRules()}</style>
          {spansByLine.map((line, index) => (
            <React.Fragment key={index}>
              {index > 0 && <br />}
              {line}
            </React.Fragment>
          ))}
        </span>
      );
    }

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

function StaticKnobReference({
  name,
  children,
  renderIdentifier,
}: {
  name: string;
  children: React.ReactNode;
  renderIdentifier?: StaticSQLHighlighterProps["renderIdentifier"];
}) {
  const editor = useEditor();
  const description = useValue(
    "Static SQL knob value",
    () => {
      const knob = findKnob(editor, name);
      return knob
        ? `{${knob.props.name}}=${describeKnob(knob)}`
        : name
          ? `{${name}} — pending creation`
          : "Type a name inside {} to create a knob";
    },
    [editor, name]
  );
  const content = (
    <span
      title={renderIdentifier ? "" : description}
      style={{
        fontFamily: "monospace",
        backgroundColor: "var(--color-teal-100, #ccfbf1)",
        color: "#115e59",
        borderBottom: "2px solid #0d9488",
      }}
      onMouseDown={(event) => {
        if (!name || (!event.ctrlKey && !event.metaKey)) return;
        event.preventDefault();
        event.stopPropagation();
        navigateToKnob(editor, name);
      }}
    >
      {children}
    </span>
  );
  return renderIdentifier ? renderIdentifier(content, { kind: "knob", name }) : content;
}

const renderWithHighlights = (
  text: string,
  keyOffset: number,
  tableNames: Map<string, string>,
  sources?: Set<string>,
  queries?: Set<string>,
  columnMapping?: Record<string, SqlColumnDefinition[]>,
  upstreamTableNames?: ReadonlySet<string>,
  mentionedTables?: ReadonlySet<string>,
  fullSql?: string,
  renderIdentifier?: StaticSQLHighlighterProps["renderIdentifier"]
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

      const content = <span style={style}>{text.slice(identifier.from, identifier.to)}</span>;
      parts.push(
        <React.Fragment key={keyOffset + identifier.from}>
          {renderIdentifier ? renderIdentifier(content, { kind: "table", tableName }) : content}
        </React.Fragment>
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

      const content = (
        <span className={`${colorClass} rounded-none text-black`} style={{ fontFamily: "monospace" }}>
          {text.slice(identifier.from, identifier.to)}
        </span>
      );
      parts.push(
        <React.Fragment key={keyOffset + identifier.from}>
          {renderIdentifier ? renderIdentifier(content, { kind: "column", column: prioritizedDef }) : content}
        </React.Fragment>
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
