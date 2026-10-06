import type { Editor } from "tldraw";
import type { KnobShape } from "./knob-types";
import { quoteSqlString } from "../src/duckdb/sql";

// Only substitute SQL code, never strings, quoted identifiers or comments.
export function mapKnobParameters(
  sql: string,
  replace: (name: string, offset: number) => string,
  allowEmpty = false
): string {
  let output = "";
  let i = 0;
  while (i < sql.length) {
    const start = i;
    if (sql.startsWith("--", i)) {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (sql.startsWith("/*", i)) {
      i += 2;
      let depth = 1;
      while (i < sql.length && depth) {
        if (sql.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
    } else if (sql[i] === "'" || sql[i] === '"' || sql[i] === "`") {
      const quote = sql[i];
      const delimiter = sql.startsWith(quote.repeat(3), i) ? quote.repeat(3) : quote;
      i += delimiter.length;
      while (i < sql.length) {
        if (sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql.startsWith(delimiter, i)) {
          i += delimiter.length;
          if (delimiter.length === 1 && sql[i] === quote) {
            i++;
            continue;
          }
          break;
        }
        i++;
      }
    } else {
      const dollar = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
      if (dollar) {
        const end = sql.indexOf(dollar, i + dollar.length);
        i = end < 0 ? sql.length : end + dollar.length;
      } else {
        const parameter = sql
          .slice(i)
          .match(allowEmpty ? /^\{([A-Za-z_][A-Za-z0-9_]*)?\}/ : /^\{([A-Za-z_][A-Za-z0-9_]*)\}/);
        if (parameter) {
          output += replace(parameter[1] ?? "", i);
          i += parameter[0].length;
          continue;
        }
        i++;
      }
    }
    output += sql.slice(start, i);
  }
  return output;
}

export function getKnobNames(sql: string): string[] {
  const names = new Set<string>();
  mapKnobParameters(sql, (name) => {
    names.add(name.toUpperCase());
    return `{${name}}`;
  });
  return [...names];
}

export function getSQLKnobs(editor: Editor, sql: string): KnobShape[] {
  const names = new Set(getKnobNames(sql));
  return editor
    .getCurrentPageShapes()
    .filter(
      (shape): shape is KnobShape => shape.type === "knob" && names.has((shape as KnobShape).props.name.toUpperCase())
    );
}

export function resolveKnobSQL(editor: Editor, sql: string): string {
  const knobs = getSQLKnobs(editor, sql);
  return mapKnobParameters(sql, (name) => {
    const matches = knobs.filter((knob) => knob.props.name.toUpperCase() === name.toUpperCase());
    if (!matches.length) throw new Error(`Missing knob {${name}}. Add a knob named ${name} on this page.`);
    if (matches.length > 1) throw new Error(`More than one knob is named ${name}. Give each knob a unique name.`);
    const knob = matches[0];
    if (knob.props.kind === "category") {
      const value = knob.props.categoryValue;
      if (value === undefined) throw new Error(`Choose a value for knob ${name}.`);
      if (knob.props.categoryType === "boolean") {
        if (value !== "true" && value !== "false") throw new Error(`Knob ${name} must be true or false.`);
        return value.toUpperCase();
      }
      return quoteSqlString(value);
    }
    const value = knob.props.value;
    if (!Number.isFinite(value)) throw new Error(`Knob ${name} must have a finite numeric value.`);
    return `(${value})`;
  });
}
