import type { SQLTextAreaShape } from "../SQLTextArea/sql-text-area-types";
import type { Editor, TLShape } from "tldraw";
import { getDbtMacroCalls } from "./dbtMacros";
import { dbtRelation } from "./dbtCanvas";
import { quoteIdentifier } from "../src/duckdb/sql";

export function hasDbtTemplate(text: string) {
  return /\{[{%#]/.test(text);
}

// The live graph can resolve literal references without compiling on every
// keystroke. Execution uses the Jinja compiler, including refs inside macros.
export function resolveDbtReferences(editor: Editor, text: string, strict = false): string {
  const shapes = editor
    .getCurrentPageShapes()
    .filter((shape) => shape.type === "sql-text-area" || shape.type === "data-source");
  return text
    .replace(/\{#[\s\S]*?#\}/g, "")
    .replace(/\{\{[-+]?\s*(ref|source)\s*\(([^]*?)\)\s*[-+]?\}\}/g, (original: string, fn: string, args: string) => {
      const parsed = args.match(/^\s*(['"])(.*?)\1\s*(?:,\s*(['"])(.*?)\3\s*)?$/);
      if (!parsed) {
        if (strict) throw new Error(`Compile this dbt expression before running: ${original}`);
        return original;
      }
      const first = parsed[2],
        second = parsed[4];
      const matches = findDbtReferenceShapes(shapes, fn, first, second);
      if (matches.length !== 1) {
        if (strict)
          throw new Error(
            `${original}: expected one upstream canvas node, found ${matches.length}. Connect the project or fix the reference.`
          );
        return original;
      }
      return quoteIdentifier((matches[0].props as { name: string }).name);
    })
    .replace(/\{\{[-+]?\s*config\s*\([\s\S]*?\)\s*[-+]?\}\}/g, "");
}

function findDbtReferenceShapes(shapes: TLShape[], fn: string, first: string, second?: string) {
  let matches = shapes.filter((shape) => {
    const relation = dbtRelation(shape);
    if (relation && !relation.bindingId) return false;
    if (fn === "source") return relation?.source === first && relation.table === second;
    if (relation)
      return !relation.source && relation.refName === (second ?? first) && (!second || relation.projectName === first);
    return !second && "name" in shape.props && shape.props.name === first;
  });
  if (fn === "ref" && matches.some((shape) => dbtRelation(shape)?.bindingId))
    matches = matches.filter((shape) => dbtRelation(shape)?.bindingId);
  return matches;
}

export function dbtReferenceSignature(editor: Editor) {
  return JSON.stringify(
    editor.getCurrentPageShapes().flatMap((shape) => {
      if ((shape.type !== "sql-text-area" && shape.type !== "data-source") || !("name" in shape.props)) return [];
      const relation = dbtRelation(shape);
      return [
        [
          shape.id,
          shape.props.name,
          relation?.bindingId,
          relation?.projectName,
          relation?.refName,
          relation?.source,
          relation?.table,
        ],
      ];
    })
  );
}

export function getDbtRelationReferences(editor: Editor, text: string) {
  const shapes = editor
    .getCurrentPageShapes()
    .filter((shape) => shape.type === "sql-text-area" || shape.type === "data-source");
  return getDbtMacroCalls(text).flatMap((call) => {
    if (call.name !== "ref" && call.name !== "source") return [];
    const args = text.slice(call.to).match(/^\s*\(\s*(['"])(.*?)\1\s*(?:,\s*(['"])(.*?)\3\s*)?\)/);
    if (!args) return [];
    const matches = findDbtReferenceShapes(shapes, call.name, args[2], args[4]);
    return matches.length === 1
      ? [
          {
            from: call.from,
            to: call.to + args[0].length,
            shapeId: matches[0].id,
            shapeType: matches[0].type,
            label: String((matches[0].props as { name: string }).name),
          },
        ]
      : [];
  });
}

export function dbtContextShape(shape: TLShape) {
  const relation = dbtRelation(shape);
  if (!relation || !relation.bindingId || !("name" in shape.props)) return null;
  return {
    id: shape.id,
    name: String(shape.props.name),
    refName: relation.refName,
    package: relation.projectName,
    sql: shape.type === "sql-text-area" ? (shape as SQLTextAreaShape).props.text : null,
    source: relation.source ?? "",
    table: relation.table ?? "",
  };
}
