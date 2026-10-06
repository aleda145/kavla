import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, showPanel, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { Editor } from "tldraw";
import { describeKnob, findKnob, getKnobReferences, isKnobCodePosition, navigateToKnob } from "../Knob/knobReferences";
import { INTERACTIVE_HOVER_TOOLTIP_CLASS, type HoverSource } from "./grace-period-hover";
import { applyTooltipPlacementStyle } from "./tooltip-position";

type KnobClause = "WHERE" | "HAVING" | "ORDER BY" | "GROUP BY" | "LIMIT" | "OFFSET";

function getKnobClause(state: EditorState, pos: number): KnobClause | null {
  const sql = state.doc.toString();
  if (!isKnobCodePosition(sql, pos)) return null;
  const hidden: { from: number; to: number }[] = [];
  syntaxTree(state).iterate({
    to: pos,
    enter(node) {
      if (
        /String|Comment|QuotedIdentifier/.test(node.name) ||
        (!node.node.firstChild && /^["`]/.test(sql.slice(node.from, node.from + 1)))
      ) {
        hidden.push({ from: node.from, to: Math.min(pos, node.to) });
        return false;
      }
    },
  });
  hidden.push(
    ...getKnobReferences(sql)
      .filter((reference) => reference.from < pos)
      .map((reference) => ({ from: reference.from, to: Math.min(pos, reference.to) }))
  );
  hidden.sort((a, b) => a.from - b.from);
  let code = "";
  let previous = 0;
  for (const range of hidden) {
    if (range.to <= previous) continue;
    code += sql.slice(previous, Math.max(previous, range.from)) + " ";
    previous = range.to;
  }
  code += sql.slice(previous, pos);
  let clause: KnobClause | null = null;
  const parents: (KnobClause | null)[] = [];
  for (const match of code.matchAll(
    /\b(?:GROUP\s+BY|ORDER\s+BY|WHERE|HAVING|LIMIT|OFFSET|SELECT|FROM|JOIN|ON|UNION|EXCEPT|INTERSECT|RETURNING)\b|[();]/gi
  )) {
    const token = match[0].toUpperCase().replace(/\s+/g, " ");
    if (token === "(") parents.push(clause);
    else if (token === ")") clause = parents.pop() ?? null;
    else if (token === ";") {
      clause = null;
      parents.length = 0;
    } else if (["WHERE", "HAVING", "ORDER BY", "GROUP BY", "LIMIT", "OFFSET"].includes(token))
      clause = token as KnobClause;
    else clause = null;
  }
  return clause;
}

export function createKnobEditorExtensions(editor: Editor) {
  const marks = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) this.decorations = this.build(update.view);
      }
      build(view: EditorView) {
        return Decoration.set(
          getKnobReferences(view.state.doc.toString()).map((reference) =>
            Decoration.mark({
              class: "cm-knob-reference",
              attributes: {
                "data-knob-name": reference.name,
                title: reference.name ? "Ctrl/Cmd+click to go to knob" : "Type a name inside {} to create a knob",
              },
            }).range(reference.from, reference.to)
          )
        );
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
      eventHandlers: {
        mousedown(event) {
          if (!event.ctrlKey && !event.metaKey) return false;
          const reference = (event.target as HTMLElement).closest<HTMLElement>(".cm-knob-reference");
          if (!reference?.dataset.knobName) return false;
          event.preventDefault();
          event.stopPropagation();
          navigateToKnob(editor, reference.dataset.knobName);
          return true;
        },
      },
    }
  );
  const hint = showPanel.of((view) => {
    const dom = document.createElement("div");
    dom.className = "cm-knob-hint";
    const button = document.createElement("button");
    button.type = "button";
    button.onpointerdown = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    button.onclick = () => {
      if (!/\{[A-Za-z_][A-Za-z0-9_]*$|\{$/.test(view.state.sliceDoc(0, view.state.selection.main.head))) {
        const { from, to } = view.state.selection.main;
        view.dispatch({
          changes: { from, to, insert: "{}" },
          selection: { anchor: from + 1 },
          userEvent: "input.type",
        });
      }
      view.focus();
    };
    dom.append(button);
    const update = () => {
      const selection = view.state.selection.main;
      const clause = getKnobClause(view.state, selection.head);
      const insideReference = getKnobReferences(view.state.doc.toString()).some(
        (reference) => reference.from < selection.head && selection.head < reference.to
      );
      dom.hidden = !view.hasFocus || view.state.readOnly || !selection.empty || !clause || insideReference;
      button.textContent =
        clause === "GROUP BY"
          ? "Use {name} to tune a grouping expression."
          : clause === "ORDER BY"
            ? "Use {name} to tune a sorting expression."
            : "Use {name} for an interactive canvas knob.";
      button.title =
        "Type {name} to create or reuse a knob after a one-second pause, or click Run. Click here to insert {}.";
    };
    update();
    return { dom, update, mount: update };
  });
  return [
    marks,
    hint,
    EditorView.baseTheme({
      ".cm-knob-reference": {
        backgroundColor: "var(--color-teal-100, #ccfbf1)",
        color: "#115e59",
        borderBottom: "2px solid #0d9488",
      },
      ".cm-knob-reference *": { color: "inherit", backgroundColor: "transparent", borderBottom: "none" },
      ".cm-knob-hint": {
        padding: "5px 8px",
        backgroundColor: "var(--color-teal-100, #ccfbf1)",
        fontFamily: "Inter, sans-serif",
        fontSize: "11px",
      },
      ".cm-knob-hint[hidden]": { display: "none" },
      ".cm-knob-hint button": {
        border: "none",
        padding: "0",
        background: "none",
        color: "#115e59",
        font: "inherit",
        textAlign: "left",
        cursor: "pointer",
      },
      ".cm-knob-hint button:hover": { textDecoration: "underline" },
    }),
  ];
}

export function getKnobHoverSource(editor: Editor, onTooltipActive?: (active: boolean) => void): HoverSource {
  return (view, pos, side) => {
    const reference = getKnobReferences(view.state.doc.toString()).find(
      (item) => item.from <= pos && item.to >= pos && !(item.from === pos && side < 0) && !(item.to === pos && side > 0)
    );
    if (!reference) return null;
    return {
      pos: reference.from,
      end: reference.to,
      above: true,
      create() {
        onTooltipActive?.(true);
        const dom = document.createElement("div");
        dom.className = `${INTERACTIVE_HOVER_TOOLTIP_CLASS} border-2 border-black rounded bg-teal-100 p-2 text-xs shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] pointer-events-auto`;
        const knob = findKnob(editor, reference.name);
        const label = document.createElement("div");
        label.textContent = knob
          ? `{${knob.props.name}} = ${describeKnob(knob)}`
          : reference.name
            ? `Knob {${reference.name}} will be created after you pause typing or click Run.`
            : "Type a name inside {} to create a knob.";
        dom.append(label);
        if (knob) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = "Go to knob · Ctrl/Cmd+click";
          button.style.cssText = "margin-top:6px;color:#115e59;cursor:pointer;font-weight:700";
          button.onpointerdown = (event) => event.stopPropagation();
          button.onclick = () => navigateToKnob(editor, reference.name);
          dom.append(button);
        }
        requestAnimationFrame(() => applyTooltipPlacementStyle(view, reference.from, dom));
        return { dom, destroy: () => onTooltipActive?.(false) };
      },
    };
  };
}
