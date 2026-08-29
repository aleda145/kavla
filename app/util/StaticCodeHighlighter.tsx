import { tsxLanguage } from "@codemirror/lang-javascript";
import { highlightCode, tagHighlighter, tags } from "@lezer/highlight";
import React, { memo, useMemo } from "react";

interface StaticCodeHighlighterProps {
  code: string;
  pendingHighlight?: boolean;
}

const pendingPatchMarkerBackground =
  "repeating-linear-gradient(180deg, rgba(239,246,255,0) 0px, rgba(239,246,255,0) 6px, rgba(219,234,254,0.22) 6px, rgba(219,234,254,0.22) 22px, rgba(239,246,255,0) 22px, rgba(239,246,255,0) 30px)";

const tsxStaticHighlighter = tagHighlighter([
  {
    tag: [tags.keyword, tags.operatorKeyword, tags.definitionKeyword, tags.controlKeyword],
    class: "kavla-code-keyword",
  },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], class: "kavla-code-string" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], class: "kavla-code-atom" },
  { tag: [tags.definition(tags.variableName), tags.function(tags.variableName)], class: "kavla-code-definition" },
  { tag: [tags.propertyName, tags.attributeName], class: "kavla-code-property" },
  { tag: [tags.className, tags.typeName, tags.tagName], class: "kavla-code-type" },
  { tag: tags.comment, class: "kavla-code-comment" },
  { tag: [tags.operator, tags.punctuation, tags.bracket], class: "kavla-code-punctuation" },
  { tag: tags.invalid, class: "kavla-code-invalid" },
]);

export const StaticCodeHighlighter = memo(({ code, pendingHighlight = false }: StaticCodeHighlighterProps) => {
  const lines = useMemo(() => {
    const output: React.ReactNode[][] = [[]];
    let key = 0;

    highlightCode(
      code,
      tsxLanguage.parser.parse(code),
      tsxStaticHighlighter,
      (text, classes) => {
        if (!text) return;
        output[output.length - 1].push(
          <span key={key++} className={classes || undefined}>
            {text}
          </span>
        );
      },
      () => {
        output.push([]);
      }
    );

    if (output.length === 0) output.push([]);
    return output;
  }, [code]);

  const gutterWidth = `calc(${String(lines.length).length}ch + 11px)`;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        overflow: "hidden",
        backgroundColor: "#fff",
        color: "#111827",
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        fontSize: 12,
        lineHeight: 1.45,
        display: "flex",
        flexDirection: "column",
        borderBottomLeftRadius: "inherit",
      }}
    >
      <style>
        {`
        .kavla-code-keyword { color: #7c3aed; font-weight: 700; }
        .kavla-code-string { color: #be123c; }
        .kavla-code-atom { color: #2563eb; }
        .kavla-code-definition { color: #2563eb; }
        .kavla-code-property { color: #b45309; }
        .kavla-code-type { color: #db2777; }
        .kavla-code-comment { color: #6b7280; font-style: italic; }
        .kavla-code-punctuation { color: #374151; }
        .kavla-code-invalid { color: #991b1b; background-color: #fee2e2; }
        `}
      </style>
      <div style={{ display: "flex", flexDirection: "row", minHeight: 10 }}>
        <div
          style={{
            minWidth: gutterWidth,
            backgroundColor: "#f3f4f6",
            borderRight: "2px solid #000",
            marginRight: 4,
          }}
        />
        <div style={{ flex: 1 }} />
      </div>
      {lines.map((lineContent, index) => (
        <div key={index} style={{ display: "flex", flexDirection: "row" }}>
          <div
            style={{
              minWidth: gutterWidth,
              textAlign: "right",
              paddingRight: 3,
              color: "#4b5563",
              backgroundColor: "#f3f4f6",
              borderRight: "2px solid #000",
              userSelect: "none",
              marginRight: 4,
            }}
          >
            {index + 1}
          </div>
          <div
            style={{
              flex: 1,
              whiteSpace: "pre",
              paddingLeft: 8,
              minWidth: 0,
            }}
          >
            {pendingHighlight ? (
              <span
                style={{
                  backgroundColor: "rgba(239,246,255,0.18)",
                  backgroundImage: pendingPatchMarkerBackground,
                  WebkitBoxDecorationBreak: "clone",
                  boxDecorationBreak: "clone",
                }}
              >
                {lineContent.length > 0 ? lineContent : " "}
              </span>
            ) : lineContent.length > 0 ? (
              lineContent
            ) : (
              " "
            )}
          </div>
        </div>
      ))}
      <div style={{ flex: 1, display: "flex", flexDirection: "row", borderBottomLeftRadius: "inherit" }}>
        <div
          style={{
            minWidth: gutterWidth,
            backgroundColor: "#f3f4f6",
            borderRight: "2px solid #000",
            marginRight: 4,
            borderBottomLeftRadius: "inherit",
          }}
        />
        <div style={{ flex: 1 }} />
      </div>
    </div>
  );
});
