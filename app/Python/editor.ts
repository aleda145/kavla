import { autocompletion } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, ViewPlugin, hoverTooltip, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { SchemaRegistry } from "../hooks/useSchemaRegistry";

export function pythonEditorExtensions(registry: SchemaRegistry, navigate: (name: string) => void) {
  const entries = Object.values(registry);
  const byName = new Map(entries.map(entry => [entry.tableName, entry]));
  const at = (view: EditorView, position: number) => {
    const node = syntaxTree(view.state).resolveInner(position, -1);
    if (node.name !== "VariableName") return null;
    const name = view.state.sliceDoc(node.from, node.to);
    return byName.has(name) ? { name, from: node.from, to: node.to } : null;
  };
  return [
    autocompletion({ override: [context => {
      const before = context.state.sliceDoc(0, context.pos);
      const column = /([A-Za-z_]\w*)\[(["'])([^"']*)$/.exec(before);
      if (column && byName.has(column[1])) return {
        from: context.pos - column[3].length,
        options: byName.get(column[1])!.columns.map(c => ({ label: c.name, type: "property", detail: c.type })),
      };
      const mapping = /shapes\[(["'])([^"']*)$/.exec(before);
      if (mapping) return { from: context.pos - mapping[2].length, options: entries.map(e => ({ label: e.tableName, type: "variable" })) };
      const node = syntaxTree(context.state).resolveInner(context.pos, -1);
      if (/Comment|String/.test(node.name)) return null;
      const word = context.matchBefore(/[A-Za-z_]\w*/);
      if (!word && !context.explicit) return null;
      return { from: word?.from ?? context.pos, options: [
        ...entries.map(e => ({ label: e.tableName, type: "variable", detail: "DataFrame", info: e.columns.map(c => `${c.name}: ${c.type}`).join("\n") })),
        { label: "result", type: "variable", detail: "Output DataFrame" },
        ...["import", "from", "def", "return", "for", "in", "if", "else", "True", "False", "None"].map(label => ({ label, type: "keyword" })),
      ] };
    }] }),
    ViewPlugin.fromClass(class {
      decorations: DecorationSet;
      constructor(view: EditorView) { this.decorations = this.build(view); }
      update(update: ViewUpdate) { if (update.docChanged || update.viewportChanged) this.decorations = this.build(update.view); }
      build(view: EditorView) {
        const marks: ReturnType<ReturnType<typeof Decoration.mark>["range"]>[] = [];
        syntaxTree(view.state).iterate({ enter(node) {
          if (node.name === "VariableName" && byName.has(view.state.sliceDoc(node.from, node.to))) {
            marks.push(Decoration.mark({ class: "cm-spatial-link-query", attributes: { title: "Ctrl/Cmd+click to go to shape" } }).range(node.from, node.to));
          }
        } });
        return Decoration.set(marks, true);
      }
    }, { decorations: value => value.decorations }),
    EditorView.domEventHandlers({ mousedown(event, view) {
      if (!event.ctrlKey && !event.metaKey) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      const reference = pos === null ? null : at(view, pos);
      if (!reference) return false;
      navigate(reference.name); event.preventDefault(); return true;
    } }),
    hoverTooltip((view, position) => {
      const reference = at(view, position);
      if (!reference) return null;
      return { pos: reference.from, end: reference.to, create() {
        const dom = document.createElement("div");
        dom.style.cssText = "padding:8px;white-space:pre;font:12px monospace;max-height:240px;overflow:auto";
        dom.textContent = `${reference.name} · DataFrame\n${byName.get(reference.name)!.columns.map(c => `${c.name}: ${c.type}`).join("\n")}`;
        return { dom };
      } };
    }),
  ];
}
