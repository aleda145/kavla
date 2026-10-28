import type { SQLTextAreaShape } from "../SQLTextArea/sql-text-area-types";
import type { Editor, TLShape } from "tldraw";
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
      let matches = shapes.filter((shape) => {
        const relation = dbtRelation(shape);
        if (relation && !relation.bindingId) return false;
        if (fn === "source") return relation?.source === first && relation.table === second;
        if (relation)
          return (
            !relation.source && relation.refName === (second ?? first) && (!second || relation.projectName === first)
          );
        return !second && "name" in shape.props && shape.props.name === first;
      });
      if (fn === "ref" && matches.some((shape) => dbtRelation(shape)?.bindingId))
        matches = matches.filter((shape) => dbtRelation(shape)?.bindingId);
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
