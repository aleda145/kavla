import type { Editor, TLShapeId } from "tldraw";
import type { DbtMacroShape } from "./dbtTypes";
import { dbtState } from "./dbtState";

// Inspect Jinja blocks only: SQL functions, quoted Jinja strings, comments and
// raw blocks are not calls to project macros. Preserve offsets for both editors.
function jinjaCode(text: string) {
  const blocks: { code: string; from: number }[] = [];
  const openings = /\{[{%#]/g;
  let opening: RegExpExecArray | null;
  while ((opening = openings.exec(text))) {
    const start = opening.index + 2;
    const close = opening[0] === "{{" ? "}}" : opening[0] === "{%" ? "%}" : "#}";
    if (close === "#}") {
      const end = text.indexOf(close, start);
      if (end < 0) break;
      openings.lastIndex = end + 2;
      continue;
    }
    let quote = "";
    let code = "";
    let end = start;
    for (; end < text.length; end++) {
      const char = text[end];
      if (quote) {
        code += " ";
        if (char === "\\" && end + 1 < text.length) {
          code += " ";
          end++;
        } else if (char === quote) quote = "";
      } else if (text.startsWith(close, end)) break;
      else if (char === "'" || char === '"') {
        quote = char;
        code += " ";
      } else code += char;
    }
    if (end === text.length) break;
    openings.lastIndex = end + 2;
    if (/^[-+]?\s*raw\s*[-+]?\s*$/.test(code)) {
      const rawEnd = /\{%[-+]?\s*endraw\s*[-+]?%\}/g;
      rawEnd.lastIndex = openings.lastIndex;
      const match = rawEnd.exec(text);
      if (!match) break;
      openings.lastIndex = rawEnd.lastIndex;
      continue;
    }
    blocks.push({ code, from: start });
  }
  return blocks;
}

export function getDbtMacroNames(text: string): string[] {
  return jinjaCode(text).flatMap(({ code }) => {
    const declaration = code.match(/^[-+]?\s*macro\s+([A-Za-z_]\w*)\s*\(/);
    return declaration ? [declaration[1]] : [];
  });
}

export function getDbtMacroCalls(text: string) {
  return jinjaCode(text).flatMap(({ code, from }) => {
    const declaration = code.match(/^[-+]?\s*macro\s+([A-Za-z_]\w*)\s*\(/);
    const declarationEnd = declaration ? declaration[0].length : 0;
    return Array.from(code.matchAll(/\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*(?=\()/g)).flatMap((match) =>
      match.index < declarationEnd
        ? []
        : [{ name: match[1], from: from + match.index, to: from + match.index + match[1].length }]
    );
  });
}

export function getDbtMacros(editor: Editor): DbtMacroShape[] {
  const binding = dbtState.get().project?.binding;
  return editor
    .getCurrentPageShapes()
    .filter(
      (shape): shape is DbtMacroShape =>
        shape.type === "dbt-macro" && Boolean(binding && (shape as DbtMacroShape).props.bindingId === binding.id)
    );
}

export function dbtMacroSignature(editor: Editor) {
  return JSON.stringify([
    dbtState.get().project?.name,
    getDbtMacros(editor).map((shape) => [shape.id, shape.props.text]),
  ]);
}

export function getDbtMacroReferences(editor: Editor, text: string) {
  const project = dbtState.get().project;
  const definitions = getDbtMacros(editor).flatMap((shape) =>
    getDbtMacroNames(shape.props.text).map((name) => ({ shape, name }))
  );
  return getDbtMacroCalls(text).flatMap((call) => {
    const matches = definitions.filter(({ name }) => call.name === name || call.name === `${project?.name}.${name}`);
    return matches.length === 1 ? [{ ...call, shapeId: matches[0].shape.id, path: matches[0].shape.props.path }] : [];
  });
}

export function getDbtMacroInputs(editor: Editor, text: string): TLShapeId[] {
  const inputs = new Set<TLShapeId>();
  const visit = (sql: string) => {
    for (const reference of getDbtMacroReferences(editor, sql)) {
      if (inputs.has(reference.shapeId)) continue;
      inputs.add(reference.shapeId);
      const macro = editor.getShape<DbtMacroShape>(reference.shapeId);
      if (macro) visit(macro.props.text);
    }
  };
  visit(text);
  return [...inputs];
}

export function navigateToDbtShape(editor: Editor, id: TLShapeId) {
  const bounds = editor.getShapePageBounds(id);
  if (!bounds) return;
  editor.select(id);
  editor.zoomToBounds(bounds, { targetZoom: editor.getZoomLevel(), animation: { duration: 200 } });
}
