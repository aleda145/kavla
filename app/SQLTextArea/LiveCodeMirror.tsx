import { useMemo, useRef, useCallback, useEffect } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { sql } from "@codemirror/lang-sql";
import { format } from "sql-formatter";
import { EditorView, Decoration, ViewPlugin, DecorationSet, ViewUpdate, keymap, tooltips } from "@codemirror/view";
import { RangeSetBuilder, Prec } from "@codemirror/state";
import { closeCompletion } from "@codemirror/autocomplete";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { useSchemaRegistry } from "../hooks/useSchemaRegistry";
import { linter, Diagnostic } from "@codemirror/lint";
import { useEditor, TLShapeId } from "tldraw";
import { DataSourceShape } from "../DataSource/data-source-types";
import { getRemoteSourceMetadata } from "../DataSource/remote-source-metadata";
import type { RemoteSourceInfo } from "./remote-column-stats";
import { useData } from "../client/useLocalServer";
import { createSqlAutocomplete } from "./sql-autocomplete";
import { getColumnHoverSource } from "./on-column-hover";
import { DuckDBDialect } from "./duckdb-dialect";
import { getColumnTypeMutedColor } from "../util/column-colors";
import { gracePeriodHoverTooltip } from "./grace-period-hover";
import { EditorValidationIssue } from "./editor-validation";
import {
  getSchemaHoverSource,
  getErrorHoverSource,
  errorTooltipField,
  errorHoverPlugin,
  errorLineGutterHighlighter,
  linterTheme,
} from "./editor-tooltips";
import {
  createSqlNameLookup,
  findMentionedTables,
  getRelevantColumns,
  scanSqlIdentifiers,
  shouldSuppressColumn,
  type SqlColumnDefinition,
} from "./sql-identifiers";
import { buildSqlSchemaIndex } from "./schema-index";

const spatialMark = Decoration.mark({
  class: "cm-spatial-link",
  attributes: { title: "Ctrl+click to go to" },
});
const queryMark = Decoration.mark({
  class: "cm-spatial-link-query",
  attributes: { title: "Ctrl+click to go to" },
});

const createSpatialPlugin = (
  validTableNames: Set<string>,
  sources: Set<string>,
  queries: Set<string>,
  onNavigate: (tableName: string) => void
) => {
  const tableNames = createSqlNameLookup(validTableNames);

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.computeDecorations(view);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = this.computeDecorations(update.view);
        }
      }

      computeDecorations(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const text = view.state.doc.toString();

        for (const identifier of scanSqlIdentifiers(text)) {
          const actualName = tableNames.get(identifier.name.toLowerCase());
          if (actualName) {
            if (queries.has(actualName)) {
              builder.add(identifier.from, identifier.to, queryMark);
            } else if (sources.has(actualName)) {
              builder.add(identifier.from, identifier.to, spatialMark);
            } else {
              builder.add(identifier.from, identifier.to, spatialMark);
            }
          }
        }

        return builder.finish();
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown: (e) => {
          if (!e.ctrlKey && !e.metaKey) return;
          const target = e.target as HTMLElement;
          if (target.classList.contains("cm-spatial-link") || target.classList.contains("cm-spatial-link-query")) {
            const clickedIdentifier = scanSqlIdentifiers(target.innerText)[0];
            const actualName = clickedIdentifier && tableNames.get(clickedIdentifier.name.toLowerCase());
            if (actualName) {
              onNavigate(actualName);
            }
            e.preventDefault();
          }
        },
      },
    }
  );
};

const createColumnHighlightPlugin = (
  columnMapping: Record<string, SqlColumnDefinition[]>,
  upstreamTableNames: string[],
  validTableNames: Set<string>
) => {
  const tableNames = createSqlNameLookup(validTableNames);
  const upstreamTables = new Set(upstreamTableNames);

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.computeDecorations(view);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = this.computeDecorations(update.view);
        }
      }

      computeDecorations(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const text = view.state.doc.toString();

        const mentionedTables = findMentionedTables(text, tableNames);

        for (const identifier of scanSqlIdentifiers(text)) {
          if (!shouldSuppressColumn(text, identifier)) {
            const colDefs = columnMapping[identifier.name.toLowerCase()];
            if (colDefs && colDefs.length > 0) {
              const prioritizedDef = getRelevantColumns(colDefs, upstreamTables, mentionedTables)[0];
              const type = prioritizedDef.type;
              const colorClass = getColumnTypeMutedColor(type);
              if (colorClass) {
                builder.add(
                  identifier.from,
                  identifier.to,
                  Decoration.mark({
                    class: `${colorClass} rounded-none text-black`,
                  })
                );
              }
            }
          }
        }

        return builder.finish();
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
};

const basicSetupOptions = {
  lineNumbers: true,
  highlightActiveLine: false,
  foldGutter: false,
  lintKeymap: true,
  autocompletion: false,
};

export type LiveCodeMirrorLanguage = "sql" | "typescript";

interface LiveCodeMirrorProps {
  shapeId: TLShapeId;
  value: string;
  onChange: (val: string) => void;
  language?: LiveCodeMirrorLanguage;
  onRun?: () => void;
  onFormat?: (val?: string) => void;
  onTooltipActive?: (active: boolean) => void;
  upstreamTableNames?: string[];
  validator?: (sql: string) => Promise<EditorValidationIssue | null>;
  onCreateEditor?: (view: EditorView) => void;
  readOnly?: boolean;
}

const typescriptHighlightStyle = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.operatorKeyword, tags.definitionKeyword, tags.controlKeyword],
    color: "#7c3aed",
    fontWeight: "700",
  },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "#be123c" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "#2563eb" },
  { tag: [tags.variableName, tags.local(tags.variableName)], color: "#111827" },
  { tag: [tags.definition(tags.variableName), tags.function(tags.variableName)], color: "#2563eb" },
  { tag: [tags.propertyName, tags.attributeName], color: "#b45309" },
  { tag: [tags.className, tags.typeName, tags.tagName], color: "#db2777" },
  { tag: tags.comment, color: "#6b7280", fontStyle: "italic" },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: "#374151" },
  { tag: tags.invalid, color: "#991b1b", backgroundColor: "#fee2e2" },
]);

const typescriptEditorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "12px",
    backgroundColor: "#fff",
    color: "#111827",
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  },
  ".cm-editor": {
    height: "100%",
    backgroundColor: "#fff",
  },
  ".cm-scroller": {
    height: "100%",
    overflow: "auto",
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  },
  ".cm-content": {
    padding: "10px 12px",
    minHeight: "100%",
    lineHeight: "1.45",
  },
  ".cm-line": {
    padding: 0,
  },
  ".cm-gutters": {
    backgroundColor: "#f3f4f6",
    color: "#4b5563",
    borderRight: "2px solid #000",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "#dbeafe",
  },
  ".cm-activeLine": {
    backgroundColor: "rgba(219, 234, 254, 0.45)",
  },
  ".cm-selectionBackground": {
    backgroundColor: "#bfdbfe !important",
  },
  "&.cm-focused": {
    outline: "none",
  },
});

export const LiveCodeMirror = ({
  shapeId,
  value,
  onChange,
  language = "sql",
  onRun,
  onFormat,
  onTooltipActive,
  upstreamTableNames = [],
  validator,
  onCreateEditor,
  readOnly = false,
}: LiveCodeMirrorProps) => {
  const registry = useSchemaRegistry();
  const editor = useEditor();
  const { runRemoteQuery, cancelRemoteQuery } = useData();
  const isFormattingRef = useRef(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const resizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Capture input before CodeMirror/tldraw so Escape keeps the shape selected
  // and scrolling stays inside the editor.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const cmEl = el.querySelector(".cm-editor") as HTMLElement | null;
        if (cmEl) {
          const view = EditorView.findFromDOM(cmEl);
          if (view) closeCompletion(view);
        }
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    };

    let canScroll = false;
    let hoverTimer: ReturnType<typeof setTimeout> | null = null;

    const onPointerEnter = () => {
      hoverTimer = setTimeout(() => {
        canScroll = true;
      }, 500);
    };

    const onPointerLeave = () => {
      if (hoverTimer) clearTimeout(hoverTimer);
      canScroll = false;
    };

    const stopProp = (e: Event) => {
      if (canScroll || editor.getSelectedShapeIds().includes(shapeId)) {
        e.stopPropagation();
      }
    };

    el.addEventListener("keydown", handler, true);
    el.addEventListener("pointerenter", onPointerEnter);
    el.addEventListener("pointerleave", onPointerLeave);
    el.addEventListener("wheel", stopProp, { passive: false });
    el.addEventListener("touchstart", stopProp, { passive: false });
    el.addEventListener("touchmove", stopProp, { passive: false });

    return () => {
      if (hoverTimer) clearTimeout(hoverTimer);
      el.removeEventListener("keydown", handler, true);
      el.removeEventListener("pointerenter", onPointerEnter);
      el.removeEventListener("pointerleave", onPointerLeave);
      el.removeEventListener("wheel", stopProp);
      el.removeEventListener("touchstart", stopProp);
      el.removeEventListener("touchmove", stopProp);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Control" || e.key === "Meta") {
        wrapperRef.current?.classList.add("cm-ctrl-pressed");
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Control" || e.key === "Meta") {
        wrapperRef.current?.classList.remove("cm-ctrl-pressed");
      }
    };

    const handleBlur = () => {
      wrapperRef.current?.classList.remove("cm-ctrl-pressed");
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  const handleCodeMirrorChange = useCallback(
    (val: string, _viewUpdate: ViewUpdate) => {
      if (isFormattingRef.current) {
        isFormattingRef.current = false;
        if (onFormat) {
          onFormat(val);
        } else {
          onChange(val);
        }
      } else {
        onChange(val);
      }
    },
    [onChange, onFormat]
  );

  const { schemaConfig, tableNames, fullSchemaConfig, allColumns, sources, queries, columnMapping, tableNameToId } =
    useMemo(() => buildSqlSchemaIndex(registry), [registry]);

  const remoteSourceMap = useMemo(() => {
    const remoteMap = new Map<string, RemoteSourceInfo>();

    for (const [shapeId, entry] of Object.entries(registry)) {
      if (entry.type !== "data-source") continue;

      const shape = editor.getShape<DataSourceShape>(shapeId as TLShapeId);
      const remoteSource = getRemoteSourceMetadata(shape);
      if (remoteSource) {
        remoteMap.set(entry.tableName, {
          sourceName: remoteSource.sourceName,
          sourceType: remoteSource.sourceType,
          fullTableRef: remoteSource.remoteTableRef,
          runRemoteQuery,
          cancelRemoteQuery,
        });
      }
    }

    return remoteMap;
  }, [registry, editor, runRemoteQuery, cancelRemoteQuery]);

  const onNavigate = useCallback(
    (tableName: string) => {
      const id = tableNameToId.get(tableName);
      if (id) {
        editor.zoomToBounds(editor.getShapePageBounds(id)!, {
          targetZoom: editor.getZoomLevel(),
          animation: { duration: 200 },
        });
        editor.select(id);
      }
    },
    [tableNameToId, editor]
  );

  const sqlLinter = useMemo(() => {
    let hasError = false;
    let pendingTimeout: ReturnType<typeof setTimeout> | null = null;
    let requestCount = 0;

    return linter(
      (view) => {
        return new Promise<Diagnostic[]>((resolve) => {
          const requestId = ++requestCount;

          if (pendingTimeout) {
            clearTimeout(pendingTimeout);
            pendingTimeout = null;
          }

          const sql = view.state.doc.toString();
          if (!sql.trim()) {
            hasError = false;
            return resolve([]);
          }

          const runValidation = async () => {
            if (requestId !== requestCount) return resolve([]);

            const issue = validator ? await validator(sql) : null;

            if (requestId !== requestCount) return resolve([]);

            if (!issue) {
              hasError = false;
              return resolve([]);
            }

            let from = 0;
            let to = sql.length;

            if (typeof issue.from === "number" && typeof issue.to === "number") {
              from = Math.max(0, Math.min(sql.length, issue.from));
              to = Math.max(from, Math.min(sql.length, issue.to));
            } else if (issue.line) {
              try {
                const line = view.state.doc.line(issue.line);
                from = line.from;
                to = line.to;

                if (issue.column) {
                  const columnOffset = Math.max(0, issue.column - 1);
                  from = Math.min(line.to, line.from + columnOffset);
                }
              } catch {
                // Keep the full-query range when the reported line is invalid.
              }
            }

            const d: Diagnostic = {
              from,
              to,
              severity: "error",
              message: issue.message,
              renderMessage: () => {
                const container = document.createElement("div");
                container.className = "min-w-[200px] flex flex-col text-xs pointer-events-auto";

                const header = document.createElement("div");
                header.className =
                  "bg-red-400 p-1.5 border-b-2 border-black font-black uppercase tracking-wider text-[10px] flex items-center gap-2 rounded-t-[2px]";
                header.innerHTML = `<span>⚠️ Error</span>`;
                container.appendChild(header);

                const body = document.createElement("div");
                body.className = "p-2 font-mono text-black font-bold rounded-b-[2px]";
                body.innerText = issue.message;
                container.appendChild(body);

                return container;
              },
            };

            hasError = true;
            resolve([d]);
          };

          const delay = hasError ? 100 : 500;
          pendingTimeout = setTimeout(() => {
            runValidation();
          }, delay);
        });
      },
      {
        delay: 50,
        needsRefresh: null,
        tooltipFilter: () => [],
      }
    );
  }, [validator]);

  const extensions = useMemo(() => {
    if (language === "typescript") {
      return [
        javascript({ jsx: true, typescript: true }),
        syntaxHighlighting(typescriptHighlightStyle, { fallback: true }),
        EditorView.lineWrapping,
        typescriptEditorTheme,
        Prec.highest(
          keymap.of([
            {
              key: "Mod-Enter",
              run: () => {
                if (onRun) {
                  onRun();
                  return true;
                }
                return false;
              },
              preventDefault: true,
            },
            {
              key: "Ctrl-Enter",
              run: () => {
                if (onRun) {
                  onRun();
                  return true;
                }
                return false;
              },
              preventDefault: true,
            },
            {
              key: "Alt-Enter",
              run: () => {
                if (onRun) {
                  onRun();
                  return true;
                }
                return false;
              },
              preventDefault: true,
            },
          ])
        ),
      ];
    }

    return [
      EditorView.updateListener.of((update) => {
        if (update.docChanged || update.geometryChanged) {
          if (resizeTimeoutRef.current) return;
          resizeTimeoutRef.current = setTimeout(() => {
            resizeTimeoutRef.current = null;
            const shape = editor.getShape(shapeId);
            if (!shape || shape.type !== "sql-text-area") return;
            if ((shape.props as any).isManuallyResized) return;

            let { w, h } = shape.props as any;
            let changed = false;

            const scroll = update.view.scrollDOM;
            const contentWidth = scroll.scrollWidth;
            const contentHeight = scroll.scrollHeight;
            const clientWidth = scroll.clientWidth;
            const clientHeight = scroll.clientHeight;

            const MAX_WIDTH = 600;
            const MAX_HEIGHT = 600;
            const BUFFER = 20;

            if (contentWidth > clientWidth && w < MAX_WIDTH) {
              w = Math.min(MAX_WIDTH, w + (contentWidth - clientWidth) + BUFFER);
              changed = true;
            }

            if (contentHeight > clientHeight && h < MAX_HEIGHT) {
              h = Math.min(MAX_HEIGHT, h + (contentHeight - clientHeight) + BUFFER);
              changed = true;
            }

            if (changed) {
              editor.updateShape({
                id: shapeId,
                type: "sql-text-area",
                props: { w, h },
              });
            }
          }, 100);
        }
      }),
      createSqlAutocomplete(tableNames, allColumns, upstreamTableNames),
      sql({
        dialect: DuckDBDialect,
        schema: schemaConfig,
        tables: Array.from(tableNames).map((t) => ({ label: t, type: "table" })),
      }),
      createSpatialPlugin(tableNames, sources, queries, onNavigate),
      createColumnHighlightPlugin(columnMapping, upstreamTableNames, tableNames), // Add column highlighting
      gracePeriodHoverTooltip(
        [
          getErrorHoverSource(onTooltipActive), // Error takes precedence
          getColumnHoverSource(columnMapping, tableNames, upstreamTableNames, onTooltipActive, remoteSourceMap),
          getSchemaHoverSource(fullSchemaConfig, onTooltipActive, remoteSourceMap),
        ],
        { hoverTime: 0, hideDelay: 300 }
      ),
      sqlLinter, // TODO tiny white border here, looks ugly but nbd
      errorLineGutterHighlighter,
      errorHoverPlugin(onTooltipActive), // Add our custom gutter error hover
      errorTooltipField,
      linterTheme,
      tooltips({ parent: document.body, position: "absolute" }),
      Prec.highest(
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => {
              if (onRun) {
                onRun();
                return true;
              }
              return false;
            },
            preventDefault: true,
          },
          {
            key: "Ctrl-Enter",
            run: () => {
              if (onRun) {
                onRun();
                return true;
              }
              return false;
            },
            preventDefault: true,
          },
          {
            key: "Alt-Enter",
            run: () => {
              if (onRun) {
                onRun();
                return true;
              }
              return false;
            },
            preventDefault: true,
          },
          {
            key: "Shift-Alt-f",
            run: (view) => {
              try {
                const original = view.state.doc.toString();
                const cursor = view.state.selection.main.head;
                const beforeCursor = original.slice(0, cursor);
                const nonWhitespaceCount = beforeCursor.replace(/\s/g, "").length;

                const formatted = format(original, {
                  language: "duckdb",
                  keywordCase: "upper",
                  tabWidth: 2,
                });

                let count = 0;
                let newCursor = 0;
                for (let i = 0; i < formatted.length; i++) {
                  if (!/\s/.test(formatted[i])) {
                    count++;
                  }
                  if (count >= nonWhitespaceCount) {
                    newCursor = i + 1;
                    break;
                  }
                }

                if (newCursor > formatted.length) newCursor = formatted.length;

                isFormattingRef.current = true;
                view.dispatch({
                  changes: { from: 0, to: original.length, insert: formatted },
                  selection: { anchor: newCursor },
                });
                return true;
              } catch (e) {
                console.error("Format error", e);
                return false;
              }
            },
            preventDefault: true,
          },
        ])
      ),
    ];
  }, [
    schemaConfig,
    tableNames,
    onRun,
    onFormat,
    fullSchemaConfig,
    sqlLinter,
    onTooltipActive,
    allColumns,
    allColumns,
    upstreamTableNames,
    validator,
    sources,
    queries,
    columnMapping,
    onNavigate,
    shapeId,
    editor,
    remoteSourceMap,
    language,
  ]);

  return (
    <div ref={wrapperRef} style={{ height: "100%", borderBottomLeftRadius: "inherit" }}>
      <style>
        {`
        .cm-editor {
          border-bottom-left-radius: 8px !important;
        }
        .cm-scroller {
          border-bottom-left-radius: 8px !important;
        }
        .cm-gutters {
          border-bottom-left-radius: 8px !important;
        }
        .cm-gutter {
          border-bottom-left-radius: 8px !important;
        }
        .cm-spatial-link {
          background-color: rgba(59, 130, 246, 0.1);
          border-bottom: 2px solid #3b82f6; /* Blue for Sources */
        }
        .cm-spatial-link-query {
          background-color: #fef9c3; /* Yellow 100 */
          border-bottom: 2px solid #ca8a04; /* Yellow 600 - darker for contrast */
        }
        /* Hover pointer only when ctrl is pressed */
        .cm-ctrl-pressed .cm-spatial-link:hover,
        .cm-ctrl-pressed .cm-spatial-link-query:hover {
          cursor: pointer;
          opacity: 0.8;
        }
        `}
      </style>
      <CodeMirror
        value={value}
        height="100%"
        extensions={extensions}
        onChange={handleCodeMirrorChange}
        onCreateEditor={onCreateEditor}
        readOnly={readOnly}
        editable={!readOnly}
        style={
          language === "typescript"
            ? { height: "100%", fontSize: 12, fontFamily: "'JetBrains Mono', 'Fira Code', monospace" }
            : { height: "100%", fontSize: 14, fontFamily: "monospace" }
        }
        basicSetup={basicSetupOptions}
      />
    </div>
  );
};
