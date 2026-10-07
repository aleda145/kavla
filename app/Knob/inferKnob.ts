import type { Editor } from "tldraw";
import type { LocalServerContextType } from "../client/localServer/types";
import { getColumnAnalysisType } from "../src/duckdb/column-stats-sql";
import { buildRemoteSQLFromDag, walkSQLDag } from "../SQLTextArea/walkSQLDag";
import { randomUUID } from "../util/randomUUID";
import { mapKnobParameters } from "./knobSQL";
import type { KnobShape } from "./knob-types";
import { getTimeStep, parseKnobTime } from "./knobTime";
import type { SQLTextAreaShape } from "../SQLTextArea/sql-text-area-types";
import { quoteIdentifier } from "../src/duckdb/sql";
import { getKnobUpstreamSources } from "./knobUpstream";

export function getKnobInferenceContext(editor: Editor, knob: KnobShape, queries: SQLTextAreaShape[]) {
  if (knob.props.inferenceColumn) {
    const upstream = getKnobUpstreamSources(editor, queries).find(({ query, source }) => {
      if (knob.props.inferenceSourceId) return source.id === knob.props.inferenceSourceId;
      const columns = source.type === "data-source" ? source.props.metadata : source.props.outputSchema;
      return (
        query.id === knob.props.inferenceQueryId &&
        columns?.some((column) => column.name === knob.props.inferenceColumn)
      );
    });
    if (!upstream) return undefined;
    return {
      query: upstream.query,
      sql: `SELECT ${quoteIdentifier(knob.props.inferenceColumn)} AS knob_value FROM ${quoteIdentifier(upstream.source.props.name)}`,
    };
  }
  return queries
    .map((query) => ({ query, sql: getKnobColumnQuery(query.props.text, knob.props.name) }))
    .find((context) => context.sql);
}

type Token = { text: string; from: number; to: number; depth: number };
const identifier = /^(?:[A-Za-z_][A-Za-z0-9_$]*|"(?:""|[^"])+"|`(?:``|[^`])+`)$/;

// Keep the FROM/JOIN inputs, but leave out the filter containing the knob.
// Inference is deliberately limited to direct column comparisons; SQL expressions
// without an unambiguous column keep their manually configurable controls.
export function getKnobColumnQuery(sql: string, name: string): string | null {
  const positions = new Set<number>();
  mapKnobParameters(sql, (parameter, offset) => {
    if (parameter.toUpperCase() === name.toUpperCase()) positions.add(offset);
    return `{${parameter}}`;
  });
  const tokens: Token[] = [];
  let depth = 0;
  const pattern =
    /--[^\r\n]*|\/\*[\s\S]*?\*\/|\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$|'(?:''|\\.|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_$]*|>=|<=|<>|!=|[^\s]/g;
  for (const match of sql.matchAll(pattern)) {
    const text = match[0];
    if (text.startsWith("--") || text.startsWith("/*")) continue;
    if (text === ")") depth--;
    tokens.push({ text, from: match.index, to: match.index + text.length, depth });
    if (text === "(") depth++;
  }
  for (let i = 0; i < tokens.length; i++) {
    if (!positions.has(tokens[i].from)) continue;
    let column: string | null = null;
    if (/^(=|!=|<>|<=|>=|<|>)$/.test(tokens[i - 1]?.text ?? "") && identifier.test(tokens[i - 2]?.text ?? "")) {
      let start = i - 2;
      while (tokens[start - 1]?.text === "." && identifier.test(tokens[start - 2]?.text ?? "")) start -= 2;
      if (/^(WHERE|AND|OR|ON|HAVING|NOT|WHEN|\()$/i.test(tokens[start - 1]?.text ?? "")) {
        column = sql.slice(tokens[start].from, tokens[i - 2].to);
      }
    } else if (/^(=|!=|<>|<=|>=|<|>)$/.test(tokens[i + 1]?.text ?? "") && identifier.test(tokens[i + 2]?.text ?? "")) {
      let end = i + 2;
      while (tokens[end + 1]?.text === "." && identifier.test(tokens[end + 2]?.text ?? "")) end += 2;
      if (
        !tokens[end + 1] ||
        /^(AND|OR|GROUP|ORDER|LIMIT|OFFSET|HAVING|THEN|UNION|EXCEPT|INTERSECT|\)|;)$/i.test(tokens[end + 1].text)
      ) {
        column = sql.slice(tokens[i + 2].from, tokens[end].to);
      }
    }
    if (!column) continue;
    const select = tokens
      .slice(0, i)
      .reverse()
      .find(
        (token) =>
          /^SELECT$/i.test(token.text) &&
          token.depth <= tokens[i].depth &&
          !tokens.some((other) => other.from > token.from && other.from < tokens[i].from && other.depth < token.depth)
      );
    if (!select) continue;
    const fromIndex = tokens.findIndex(
      (token) => token.from > select.from && token.depth === select.depth && /^FROM$/i.test(token.text)
    );
    if (fromIndex < 0 || tokens[fromIndex].from > tokens[i].from) continue;
    const end = tokens
      .slice(fromIndex + 1)
      .find(
        (token) =>
          token.depth < select.depth ||
          (token.depth === select.depth &&
            /^(WHERE|GROUP|HAVING|ORDER|LIMIT|OFFSET|FETCH|UNION|EXCEPT|INTERSECT|QUALIFY|WINDOW|;)$/i.test(token.text))
      );
    const prefix = select.depth === 0 ? sql.slice(0, select.from) : "";
    const source = sql.slice(tokens[fromIndex].from, end?.from ?? sql.length).trim();
    return `${prefix}SELECT ${column} AS knob_value ${source}`;
  }
  return null;
}

export async function inferKnob(
  editor: Editor,
  data: LocalServerContextType,
  knob: KnobShape,
  columnQuery: string,
  signal: AbortSignal
): Promise<Partial<KnobShape["props"]>> {
  const plan = walkSQLDag(editor, columnQuery);
  if (!plan.ok) throw new Error(plan.error.message);
  const { orderedDependencies, executionState } = plan.plan;
  const input = buildRemoteSQLFromDag(columnQuery, orderedDependencies, editor);
  const requestId = `knob-options:${randomUUID()}`;
  const cancel = () => data.cancelRemoteQuery(requestId);
  signal.addEventListener("abort", cancel, { once: true });
  const run = async (sql: string) => {
    signal.throwIfAborted();
    const result = await data.runRemoteQuery({
      sql,
      shapeId: requestId,
      transient: true,
      sourceName: executionState.sourceName,
      sourceType: executionState.sourceType,
      sourceNative: executionState.sourceNativePreview,
    });
    signal.throwIfAborted();
    return result;
  };
  try {
    const description = await run(`SELECT * FROM (${input}) AS knob_input LIMIT 0`);
    const columnType = description.schema[0]?.type ?? "";
    const analysisType = getColumnAnalysisType(columnType);
    if (/^(BOOL|BOOLEAN)$/i.test(columnType)) {
      return {
        kind: "boolean",
        categoryType: "boolean",
        categoryValue: knob.props.categoryValue === "false" ? "false" : "true",
        options: ["false", "true"],
        optionsTruncated: false,
      };
    }
    if (analysisType === "temporal" && /DATE|TIMESTAMP/i.test(columnType)) {
      const result = await run(
        `SELECT CAST(MIN(knob_value) AS VARCHAR) AS min_value, CAST(MAX(knob_value) AS VARCHAR) AS max_value FROM (${input}) AS knob_input`
      );
      const row = result.sampleRows[0];
      if (row?.min_value == null || row?.max_value == null) throw new Error("This column has no non-null values yet.");
      const min = Math.floor(parseKnobTime(row.min_value) / 1000) * 1000;
      const max = Math.ceil(parseKnobTime(row.max_value) / 1000) * 1000;
      const temporalType = /^DATE$/i.test(columnType)
        ? "date"
        : /TIMESTAMPTZ|WITH TIME ZONE/i.test(columnType) ||
            (executionState.sourceNativePreview &&
              executionState.sourceType === "bigquery" &&
              /^TIMESTAMP$/i.test(columnType))
          ? "timestamptz"
          : "timestamp";
      return {
        kind: "timestamp",
        temporalType,
        min,
        max,
        step: getTimeStep(min, max, temporalType),
        value:
          knob.props.kind === "timestamp"
            ? Math.max(min, Math.min(max, Math.floor(knob.props.value / 1000) * 1000))
            : min,
        optionsTruncated: false,
      };
    }
    if (analysisType === "numeric") {
      const result = await run(
        `SELECT MIN(knob_value) AS min_value, MAX(knob_value) AS max_value FROM (${input}) AS knob_input`
      );
      const row = result.sampleRows[0];
      if (row?.min_value == null || row?.max_value == null) throw new Error("This column has no non-null values yet.");
      const min = Number(row.min_value);
      const max = Number(row.max_value);
      if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(max - min))
        throw new Error("This column's range cannot be represented by a slider.");
      const scale = columnType.match(/DECIMAL\s*\(\s*\d+\s*,\s*(\d+)\s*\)/i)?.[1];
      const step = /INT/i.test(columnType)
        ? 1
        : scale !== undefined
          ? 10 ** -Number(scale)
          : max > min
            ? 10 ** Math.floor(Math.log10((max - min) / 100))
            : 0.01;
      return {
        kind: "numeric",
        min,
        max,
        step: Math.max(Number.MIN_VALUE, step),
        value: Math.max(min, Math.min(max, knob.props.value)),
        optionsTruncated: false,
      };
    }
    if (analysisType !== "text" && !/BOOL|^ENUM|^UUID/i.test(columnType)) {
      throw new Error(
        `Automatic knobs do not support ${columnType || "this column type"} yet. Configure the knob manually.`
      );
    }
    const result = await run(
      `SELECT DISTINCT knob_value FROM (${input}) AS knob_input WHERE knob_value IS NOT NULL ORDER BY knob_value LIMIT 201`
    );
    const options = result.sampleRows.slice(0, 200).map((row) => String(row.knob_value));
    if (!options.length) throw new Error("This column has no non-null values yet.");
    return {
      kind: "category",
      categoryType: /BOOL/i.test(columnType) ? "boolean" : "text",
      options,
      categoryValue:
        knob.props.categoryValue !== undefined && options.includes(knob.props.categoryValue)
          ? knob.props.categoryValue
          : options[0],
      optionsTruncated: result.sampleRows.length > 200,
    };
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
