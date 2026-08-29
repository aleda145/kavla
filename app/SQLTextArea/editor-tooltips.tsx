import { createRoot } from "react-dom/client";
import {
  EditorView,
  ViewPlugin,
  ViewUpdate,
  Tooltip,
  showTooltip,
  GutterMarker,
  gutterLineClass,
} from "@codemirror/view";
import { StateField, StateEffect, EditorState, RangeSetBuilder, RangeSet } from "@codemirror/state";
import { Diagnostic, forEachDiagnostic } from "@codemirror/lint";
import { ColumnHoverTooltip } from "./ColumnHoverTooltip";
import type { RemoteSourceInfo } from "./remote-column-stats";
import { applyTooltipPlacementStyle } from "./tooltip-position";
import { getColumnTypeColor } from "../util/column-colors";

import { INTERACTIVE_HOVER_TOOLTIP_CLASS, type HoverSource } from "./grace-period-hover";

const COLUMN_TOOLTIP_HIDE_DELAY = 200;

export const getSchemaHoverSource = (
  fullSchemaConfig: { [table: string]: { name: string; type: string }[] },
  onTooltipActive?: (active: boolean) => void,
  remoteSourceMap?: Map<string, RemoteSourceInfo>
): HoverSource => {
  return (view, pos, side) => {
    const { from, to, text } = view.state.doc.lineAt(pos);
    let start = pos,
      end = pos;
    let inQuotes = false;
    let quoteStart = pos;
    let quoteEnd = pos;

    while (quoteStart > from) {
      if (text[quoteStart - from - 1] === '"') {
        inQuotes = true;
        break;
      }
      if (text[quoteStart - from - 1] === undefined || text[quoteStart - from - 1] === "") break;
      quoteStart--;
    }

    if (inQuotes) {
      while (quoteEnd < to) {
        if (text[quoteEnd - from] === '"') {
          quoteEnd++;
          break;
        }
        quoteEnd++;
      }
      start = quoteStart - 1;
      end = quoteEnd;
    } else {
      while (start > from && /\w/.test(text[start - from - 1])) start--;
      while (end < to && /\w/.test(text[end - from])) end++;
    }

    if ((start == pos && side < 0) || (end == pos && side > 0) || start === end) return null;

    let word = text.slice(start - from, end - from);
    if (inQuotes) {
      word = word.replace(/(^")|("$)/g, "");
    }
    const actualName = Object.keys(fullSchemaConfig).find((t) => t.toLowerCase() === word.toLowerCase());
    const columns = actualName ? fullSchemaConfig[actualName] : undefined;

    if (!columns || !actualName) return null;

    return {
      pos: start,
      end,
      above: true,
      create(_view) {
        if (onTooltipActive) onTooltipActive(true);
        const dom = document.createElement("div");
        dom.className = `${INTERACTIVE_HOVER_TOOLTIP_CLASS} border-2 border-black rounded text-xs bg-white shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] pointer-events-auto`;
        requestAnimationFrame(() => {
          applyTooltipPlacementStyle(_view, start, dom);
        });

        const scrollContainer = document.createElement("div");
        scrollContainer.className = "bg-white max-h-[60vh] overflow-y-auto rounded-[2px] custom-scrollbar";

        const table = document.createElement("table");
        table.className = "w-full text-left border-collapse";

        const thead = document.createElement("thead");
        thead.className = "sticky top-0 bg-gray-100 z-10 border-b-2 border-black";

        const headerRow = document.createElement("tr");
        headerRow.className = "font-black uppercase tracking-wider text-[10px]";

        const thCol = document.createElement("th");
        thCol.className = "p-1.5 pl-2 font-black";
        thCol.innerText = "Column";

        const thType = document.createElement("th");
        thType.className = "p-1.5 pr-2 w-[1%] whitespace-nowrap font-black text-left";
        thType.innerText = "Type";

        headerRow.appendChild(thCol);
        headerRow.appendChild(thType);
        thead.appendChild(headerRow);
        table.appendChild(thead);

        let tooltipContainer: HTMLDivElement | null = null;
        let tooltipRoot: any = null;
        let activeHoverColumn: string | null = null;
        let activeHoverTimeout: NodeJS.Timeout | null = null;

        const cleanupTooltip = () => {
          if (activeHoverTimeout) {
            clearTimeout(activeHoverTimeout);
            activeHoverTimeout = null;
          }
          if (tooltipRoot) {
            activeHoverColumn = null;
            tooltipRoot.unmount();
            tooltipRoot = null;
          }
          if (tooltipContainer) {
            tooltipContainer.remove();
            tooltipContainer = null;
          }
        };

        const handleRowMouseEnter = (e: MouseEvent, colName: string, colType: string) => {
          if (activeHoverColumn === colName) {
            if (activeHoverTimeout) {
              clearTimeout(activeHoverTimeout);
              activeHoverTimeout = null;
            }
            return;
          }

          cleanupTooltip();
          activeHoverColumn = colName;

          const target = e.currentTarget as HTMLElement;
          const rect = target.getBoundingClientRect();

          tooltipContainer = document.createElement("div");
          tooltipContainer.classList.add(INTERACTIVE_HOVER_TOOLTIP_CLASS);
          tooltipContainer.style.position = "fixed";
          tooltipContainer.style.top = `${rect.top}px`;

          const spaceOnLeft = rect.left;
          const minTooltipWidth = 300;

          if (spaceOnLeft >= minTooltipWidth) {
            tooltipContainer.style.right = `${window.innerWidth - rect.left + 4}px`;
            tooltipContainer.style.left = "auto";
          } else {
            tooltipContainer.style.left = `${rect.right + 4}px`;
            tooltipContainer.style.right = "auto";
          }
          tooltipContainer.style.zIndex = "1000000";
          tooltipContainer.style.pointerEvents = "auto";

          tooltipContainer.addEventListener("mouseenter", () => {
            if (activeHoverTimeout) {
              clearTimeout(activeHoverTimeout);
              activeHoverTimeout = null;
            }
          });
          tooltipContainer.addEventListener("mouseleave", () => {
            activeHoverTimeout = setTimeout(() => {
              cleanupTooltip();
            }, COLUMN_TOOLTIP_HIDE_DELAY);
          });

          document.body.appendChild(tooltipContainer);

          tooltipRoot = createRoot(tooltipContainer);
          tooltipRoot.render(
            <div className="pointer-events-auto">
              <ColumnHoverTooltip
                columnName={colName}
                type={colType}
                tableName={actualName}
                remoteSource={remoteSourceMap?.get(actualName) ?? null}
              />
            </div>
          );
        };

        const handleRowMouseLeave = () => {
          activeHoverTimeout = setTimeout(() => {
            cleanupTooltip();
          }, COLUMN_TOOLTIP_HIDE_DELAY);
        };

        const tbody = document.createElement("tbody");
        tbody.className = "text-xs";

        columns.forEach((col) => {
          const tr = document.createElement("tr");
          tr.className =
            "border-b border-gray-200 hover:bg-yellow-50 font-mono last:border-b-0 transition-colors cursor-default group";

          const tdName = document.createElement("td");
          tdName.className = "p-1.5 pl-2 truncate max-w-[200px] font-bold";
          tdName.innerText = col.name;

          const tdType = document.createElement("td");
          tdType.className = "p-1.5 pr-2 w-[1%] whitespace-nowrap text-gray-500";

          const colorClass = getColumnTypeColor(col.type);
          const typeSpan = document.createElement("span");
          typeSpan.innerText = col.type;
          if (colorClass) {
            typeSpan.className = `px-1.5 rounded-none text-black ${colorClass}`;
          }
          tdType.appendChild(typeSpan);

          tr.appendChild(tdName);
          tr.appendChild(tdType);

          tr.addEventListener("mouseenter", (e) => handleRowMouseEnter(e, col.name, col.type));
          tr.addEventListener("mouseleave", handleRowMouseLeave);

          tbody.appendChild(tr);
        });

        table.appendChild(tbody);
        scrollContainer.appendChild(table);
        dom.appendChild(scrollContainer);

        return {
          dom,
          destroy: () => {
            cleanupTooltip();
            if (onTooltipActive) onTooltipActive(false);
          },
        };
      },
    };
  };
};

// Prevent the gutter and squiggly error tooltips from opening together.
let activeSquigglyTooltip = false;

function buildErrorTooltipDOM(
  diagnostic: Diagnostic,
  view: EditorView,
  pos: number,
  isSquiggly: boolean,
  onTooltipActive?: (active: boolean) => void
) {
  if (onTooltipActive) onTooltipActive(true);

  if (isSquiggly) {
    activeSquigglyTooltip = true;
  }

  const dom = document.createElement("div");
  dom.className =
    "custom-error-tooltip border-2 border-black rounded text-xs bg-white shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] z-[1000001] pointer-events-auto flex flex-col";

  if (isSquiggly) {
    requestAnimationFrame(() => {
      applyTooltipPlacementStyle(view, pos, dom, 8, "1000001");
    });
  } else {
    dom.style.transform = "translateX(calc(-100% - 10px))";
    dom.style.marginTop = "2px";
  }

  const header = document.createElement("div");
  header.className =
    "bg-red-400 w-full p-1.5 border-b-2 border-black font-black uppercase tracking-wider text-[10px] flex items-center gap-2 rounded-t-[2px]";
  header.innerHTML = `<span>⚠️ Error</span>`;
  dom.appendChild(header);

  const body = document.createElement("div");
  body.className = "w-full p-1 font-mono text-black font-bold rounded-b-[2px] whitespace-pre-wrap max-w-[400px]";
  body.innerText = diagnostic.message;
  dom.appendChild(body);

  return {
    dom,
    destroy: () => {
      if (isSquiggly) {
        activeSquigglyTooltip = false;
      }
      if (onTooltipActive) onTooltipActive(false);
    },
  };
}

export const getErrorHoverSource = (onTooltipActive?: (active: boolean) => void): HoverSource => {
  return (view, pos, _side) => {
    let diagnostic: Diagnostic | null = null;

    forEachDiagnostic(view.state, (d, from, to) => {
      if (pos >= from && pos <= to && d.severity === "error") {
        diagnostic = d;
      }
    });

    if (!diagnostic) return null;

    return {
      pos,
      above: true,
      create(view) {
        return buildErrorTooltipDOM(diagnostic!, view, pos, true, onTooltipActive);
      },
    };
  };
};

const setErrorTooltip = StateEffect.define<Tooltip | null>();

export const errorTooltipField = StateField.define<Tooltip | null>({
  create() {
    return null;
  },
  update(tooltip, tr) {
    for (const e of tr.effects) {
      if (e.is(setErrorTooltip)) return e.value;
    }
    if (tr.docChanged || tr.selection) return null;
    return tooltip;
  },
  provide: (f) => showTooltip.from(f),
});

export const errorHoverPlugin = (onTooltipActive?: (active: boolean) => void) =>
  ViewPlugin.fromClass(
    class {
      activeDiagnostic: Diagnostic | null = null;
      hoverTimeout: NodeJS.Timeout | null = null;
      lastMouseEvent: MouseEvent | null = null;

      constructor(public view: EditorView) {
        view.dom.addEventListener("mousemove", this.handleMouseMove);
        view.dom.addEventListener("mouseleave", this.handleMouseLeave);
        view.scrollDOM.addEventListener("scroll", this.handleScroll);
      }

      destroy() {
        if (this.hoverTimeout) clearTimeout(this.hoverTimeout);
        this.clearTooltip();
        this.view.dom.removeEventListener("mousemove", this.handleMouseMove);
        this.view.dom.removeEventListener("mouseleave", this.handleMouseLeave);
        this.view.scrollDOM.removeEventListener("scroll", this.handleScroll);
      }

      update(update: ViewUpdate) {
        if ((update.docChanged || update.selectionSet) && this.activeDiagnostic) {
          this.clearTooltip();
        }
      }

      handleScroll = () => {
        this.clearTooltip();
      };

      clearTooltip() {
        if (this.activeDiagnostic) {
          this.activeDiagnostic = null;
          this.view.dispatch({ effects: setErrorTooltip.of(null) });
        }
      }

      handleMouseMove = (e: MouseEvent) => {
        this.lastMouseEvent = e;
        if (this.hoverTimeout) clearTimeout(this.hoverTimeout);

        const target = e.target as HTMLElement;

        if (!target.classList.contains("cm-error-line-gutter") && !target.closest(".cm-tooltip")) {
          this.clearTooltip();
          return;
        }

        this.hoverTimeout = setTimeout(this.checkHover, 150);
      };

      checkHover = () => {
        if (!this.lastMouseEvent) return;

        if (activeSquigglyTooltip) {
          this.clearTooltip();
          return;
        }

        const e = this.lastMouseEvent;
        const target = e.target as HTMLElement;

        let foundDiag: Diagnostic | null = null;
        let pos = -1;

        if (target.classList.contains("cm-error-line-gutter")) {
          const lineBlock = this.view.lineBlockAtHeight(e.clientY - this.view.documentTop);
          pos = lineBlock.from;
          forEachDiagnostic(this.view.state, (d, from, to) => {
            if ((pos >= from && pos <= to) || (from >= lineBlock.from && from <= lineBlock.to)) {
              if (d.severity === "error") foundDiag = d;
            }
          });
        }

        const validDiag = foundDiag as unknown as Diagnostic;
        if (validDiag && validDiag !== this.activeDiagnostic) {
          this.activeDiagnostic = validDiag;
          const tooltip: any = {
            pos: pos,
            above: true,
            create: (view: EditorView) => {
              return buildErrorTooltipDOM(validDiag, view, pos, false, onTooltipActive);
            },
          };
          this.view.dispatch({ effects: setErrorTooltip.of(tooltip) });
        } else if (!validDiag && this.activeDiagnostic) {
          if (!target.closest(".cm-tooltip")) {
            this.clearTooltip();
          }
        }
      };

      handleMouseLeave = () => {
        if (this.hoverTimeout) clearTimeout(this.hoverTimeout);
        this.clearTooltip();
      };
    }
  );

const errorGutterMarker = new (class extends GutterMarker {
  elementClass = "cm-error-line-gutter";
})();

function buildGutterMarkers(state: EditorState): RangeSet<GutterMarker> {
  const builder = new RangeSetBuilder<GutterMarker>();
  const errorLines = new Set<number>();

  forEachDiagnostic(state, (d, from, _to) => {
    if (d.severity === "error") {
      try {
        const line = state.doc.lineAt(from);
        errorLines.add(line.from);
      } catch {
        // Ignore diagnostics whose positions fall outside the document.
      }
    }
  });

  const sortedLines = Array.from(errorLines).sort((a, b) => a - b);
  for (const pos of sortedLines) {
    builder.add(pos, pos, errorGutterMarker);
  }
  return builder.finish();
}

export const errorLineGutterHighlighter = StateField.define<RangeSet<GutterMarker>>({
  create(state) {
    return buildGutterMarkers(state);
  },
  update(_, tr) {
    return buildGutterMarkers(tr.state);
  },
  provide: (f) => gutterLineClass.from(f),
});

export const linterTheme = EditorView.theme({
  ".cm-error-line-gutter": {
    backgroundColor: "#f87171 !important" /* Tailwind red-400 */,
    color: "white !important",
    transition: "background-color 0.2s",
  },
  ".cm-activeLineGutter.cm-error-line-gutter": {
    backgroundColor: "#ef4444 !important" /* Tailwind red-500 for active state matching */,
  },

  ".cm-tooltip-lint": {
    display: "none !important",
  },
  ".cm-tooltip-arrow": {
    display: "none !important",
  },
});
