import type { Editor } from "tldraw";
import type { KnobShape } from "./knob-types";
import { quoteSqlString } from "../src/duckdb/sql";
import { formatKnobTime } from "./knobTime";

type KnobSQLToken = {
  text: string;
  from: number;
  to: number;
  kind: "code" | "identifier" | "literal" | "parameter" | "ignored";
};

function tokenizeKnobSQL(sql: string): KnobSQLToken[] {
  const tokens: KnobSQLToken[] = [];
  let i = 0;
  while (i < sql.length) {
    const start = i;
    let kind: KnobSQLToken["kind"] = "code";
    if (/\s/.test(sql[i])) {
      kind = "ignored";
      while (i < sql.length && /\s/.test(sql[i])) i++;
    } else if (sql.startsWith("--", i)) {
      kind = "ignored";
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (sql.startsWith("/*", i)) {
      kind = "ignored";
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
      kind = quote === "'" ? "literal" : "identifier";
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
        kind = "literal";
        const end = sql.indexOf(dollar, i + dollar.length);
        i = end < 0 ? sql.length : end + dollar.length;
      } else {
        const parameter = sql.slice(i).match(/^\{([A-Za-z_][A-Za-z0-9_]*)?\}/);
        if (parameter) {
          kind = "parameter";
          i += parameter[0].length;
        } else {
          const code = sql.slice(i).match(/^(?:[A-Za-z_][A-Za-z0-9_$]*|>=|<=|<>|!=|==|=>|:=|\|\|)/)?.[0];
          i += code?.length ?? 1;
        }
      }
    }
    tokens.push({ text: sql.slice(start, i), from: start, to: i, kind });
  }
  return tokens;
}

// Only substitute SQL code, never strings, quoted identifiers or comments.
export function mapKnobParameters(
  sql: string,
  replace: (name: string, offset: number) => string,
  allowEmpty = false
): string {
  return tokenizeKnobSQL(sql)
    .map((token) => {
      if (token.kind !== "parameter" || (!allowEmpty && token.text === "{}")) return token.text;
      return replace(token.text.slice(1, -1), token.from);
    })
    .join("");
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

function resolveAllCategories(sql: string, knobs: KnobShape[]): string {
  if (
    !knobs.some(
      (knob) => knob.props.kind === "category" && knob.props.categoryType !== "boolean" && knob.props.categoryAll
    )
  )
    return sql;
  const tokens = tokenizeKnobSQL(sql).filter((token) => token.kind !== "ignored");
  const edits: { from: number; to: number }[] = [];
  const isColumnPart = (index: number) => {
    const token = tokens[index];
    return token?.kind === "identifier" || (token?.kind === "code" && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(token.text));
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== "parameter") continue;
    const name = token.text.slice(1, -1);
    const matches = knobs.filter((knob) => knob.props.name.toUpperCase() === name.toUpperCase());
    if (matches.length !== 1) continue;
    const { kind, categoryType, categoryAll } = matches[0].props;
    if (kind !== "category" || categoryType === "boolean" || !categoryAll) continue;
    let start = i;
    let end = i;
    if (tokens[i - 1]?.text === "=" && isColumnPart(i - 2)) {
      start = i - 2;
      while (tokens[start - 1]?.text === "." && isColumnPart(start - 2)) start -= 2;
    } else if (tokens[i + 1]?.text === "=" && isColumnPart(i + 2)) {
      end = i + 2;
      while (tokens[end + 1]?.text === "." && isColumnPart(end + 2)) end += 2;
    }
    const before = tokens[start - 1];
    const after = tokens[end + 1];
    if (
      (start === i && end === i) ||
      (before && (before.kind !== "code" || !/^(WHERE|AND|OR|ON|HAVING|WHEN|NOT|SELECT|\(|,)$/i.test(before.text))) ||
      (after &&
        (after.kind !== "code" ||
          !/^(AND|OR|GROUP|ORDER|LIMIT|OFFSET|HAVING|THEN|ELSE|END|UNION|EXCEPT|INTERSECT|QUALIFY|WINDOW|AS|\)|,|;)$/i.test(
            after.text
          )))
    ) {
      throw new Error(`All for knob ${name} requires a direct column equality, such as author = {${name}}.`);
    }
    edits.push({ from: tokens[start].from, to: tokens[end].to });
  }
  for (const edit of edits.reverse()) sql = sql.slice(0, edit.from) + "TRUE" + sql.slice(edit.to);
  return sql;
}

export function resolveKnobSQL(editor: Editor, sql: string): string {
  const knobs = getSQLKnobs(editor, sql);
  return mapKnobParameters(resolveAllCategories(sql, knobs), (name) => {
    const matches = knobs.filter((knob) => knob.props.name.toUpperCase() === name.toUpperCase());
    if (!matches.length) throw new Error(`Missing knob {${name}}. Add a knob named ${name} on this page.`);
    if (matches.length > 1) throw new Error(`More than one knob is named ${name}. Give each knob a unique name.`);
    const knob = matches[0];
    if (knob.props.kind === "text") return quoteSqlString(knob.props.categoryValue ?? "");
    if (knob.props.kind === "timestamp") {
      const type = knob.props.temporalType ?? "timestamp";
      const value = formatKnobTime(knob.props.value, type);
      return `CAST(${quoteSqlString(type === "timestamptz" ? `${value}Z` : value)} AS ${type.toUpperCase()})`;
    }
    if (knob.props.kind === "category" || knob.props.kind === "boolean") {
      const value = knob.props.categoryValue;
      if (value === undefined) throw new Error(`Choose a value for knob ${name}.`);
      if (knob.props.kind === "boolean" || knob.props.categoryType === "boolean") {
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

export { tokenizeKnobSQL as tokenizeSQL };
