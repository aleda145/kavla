import { Dialect, parse } from "@polyglot-sql/sdk";
import type { Editor } from "tldraw";
import { getSQLBizSummary, type BizMacroCall, type BizStep, type BizSummary } from "../SQLTextArea/sqlBizSummary";
import { getDbtJinjaBlocks, getDbtMacroReferences } from "./dbtMacros";

type MacroTrace = { start: string; end: string; macros: BizMacroCall[] };

// Mark output blocks inside the Jinja expression so whitespace-control tags
// retain their meaning. The compiler still evaluates the original expression.
export function traceDbtBizMacros(editor: Editor, text: string) {
  const references = getDbtMacroReferences(editor, text);
  const traces: MacroTrace[] = [];
  let prefix = "kavla_biz_macro_";
  while (text.includes(prefix)) prefix = `_${prefix}`;
  let source = "";
  let position = 0;
  for (const block of getDbtJinjaBlocks(text)) {
    if (block.kind !== "{{") continue;
    const calls = references.filter((reference) => reference.from >= block.from && reference.to <= block.to);
    if (!calls.length) continue;
    const expression = text
      .slice(block.from, block.to)
      .replace(/^[-+]|[-+]$/g, "")
      .trim();
    const start = `/*${prefix}${traces.length}_start*/`;
    const end = `/*${prefix}${traces.length}_end*/`;
    traces.push({
      start,
      end,
      macros: calls.map((call) => ({ ...call, call: `{{ ${expression} }}` })),
    });
    const left = /^[-+]/.test(text.slice(block.from)) ? text[block.from] : "";
    const right = /[-+]/.test(text[block.to - 1]) ? text[block.to - 1] : "";
    source += text.slice(position, block.from - 2) + `{{${left} '${start}' ~ (${expression}) ~ '${end}' ${right}}}`;
    position = block.to + 2;
  }
  return { text: source + text.slice(position), traces };
}

export function getDbtQueryBizSummary(compiled: string, traces: readonly MacroTrace[]): BizSummary {
  if (!traces.length) return getSQLBizSummary(compiled);
  const wrappers = new Map<string, BizMacroCall[]>();
  const fragments: BizStep[] = [];
  const calls: BizStep[] = [];
  let prefix = "kavla_biz_call_";
  while (compiled.includes(prefix)) prefix = `_${prefix}`;
  let sql = compiled;
  let clean = compiled;
  for (const trace of traces) {
    clean = clean.replaceAll(trace.start, "").replaceAll(trace.end, "");
    let start: number;
    while ((start = sql.indexOf(trace.start)) !== -1) {
      const end = sql.indexOf(trace.end, start + trace.start.length);
      if (end === -1) return { steps: [], note: null, error: "The compiled macro is missing its closing marker." };
      const body = sql.slice(start + trace.start.length, end);
      const name = `${prefix}${wrappers.size}`;
      const expression = parse(`SELECT ${name}(${body})`, Dialect.DuckDB);
      const root = expression.ast?.[0];
      const projection = root && "select" in root ? root.select.expressions[0] : undefined;
      const statement = parse(body, Dialect.DuckDB).ast?.[0];
      const isQuery =
        statement &&
        ("select" in statement || "union" in statement || "intersect" in statement || "except" in statement);
      const isExpression =
        expression.success &&
        expression.ast?.length === 1 &&
        projection &&
        "function" in projection &&
        projection.function.args.length === 1 &&
        !isQuery;
      const call: BizStep = {
        label: "MACRO",
        detail: body.trim(),
        macros: trace.macros,
        card: { primary: trace.macros[0].call },
      };
      calls.push(call);
      if (isExpression) wrappers.set(name, trace.macros);
      else fragments.push(call);
      sql = sql.slice(0, start) + (isExpression ? `${name}(${body})` : body) + sql.slice(end + trace.end.length);
    }
  }
  // A macro can emit a whole query or SQL clause instead of an expression.
  // Keep those calls inspectable without pretending they are scalar functions.
  const wholeQuery = fragments.find((step) => step.detail === clean.trim());
  if (wholeQuery) return { steps: [wholeQuery], note: null };
  const summary = getSQLBizSummary(sql, wrappers, clean);
  if (summary.error && wrappers.size) {
    // For example, a macro expanded inside a quoted SQL string cannot carry a
    // function wrapper. Keep the real compiled query available for inspection.
    const fallback = getSQLBizSummary(clean);
    return { ...fallback, steps: [...calls, ...fallback.steps] };
  }
  const visible = new Set<string>();
  const macroKey = (macro: BizMacroCall) => JSON.stringify([macro.shapeId, macro.call]);
  const visit = (steps: BizStep[]) => {
    for (const step of steps) {
      step.macros?.forEach((macro) => visible.add(macroKey(macro)));
      if (step.children) visit(step.children);
    }
  };
  visit(summary.steps);
  // Relation, limit and other fragment macros may not own a transformation
  // card. Keep a reference to those calls alongside the compiled operations.
  const remaining = calls.filter((step) => step.macros?.some((macro) => !visible.has(macroKey(macro))));
  return remaining.length ? { ...summary, steps: [...remaining, ...summary.steps] } : summary;
}

export function getDbtMacroBizSummary(text: string): BizSummary {
  const blocks = getDbtJinjaBlocks(text);
  const steps: BizStep[] = [];
  for (const [index, block] of blocks.entries()) {
    if (block.kind !== "{%") continue;
    const declaration = block.code.match(/^[-+]?\s*macro\s+([A-Za-z_]\w*)\s*\(([\s\S]*)\)\s*[-+]?\s*$/);
    if (!declaration) continue;
    const name = declaration[1];
    const end = blocks.slice(index + 1).find((next) => next.kind === "{%" && /^[-+]?\s*endmacro\b/.test(next.code));
    if (!end) return { steps, note: null, error: `Missing endmacro for ${name}.` };
    const parameters = new Set<string>();
    let depth = 0;
    let from = 0;
    const signature = declaration[2] + ",";
    for (let i = 0; i < signature.length; i++) {
      if ("([{".includes(signature[i])) depth++;
      if (")]}".includes(signature[i])) depth--;
      if (signature[i] === "," && depth === 0) {
        const parameter = signature
          .slice(from, i)
          .trim()
          .match(/^([A-Za-z_]\w*)/);
        if (parameter) parameters.add(parameter[1]);
        from = i + 1;
      }
    }
    const body = text.slice(block.to + 2, end.from - 2).trim();
    if (!body) continue;
    // Named arguments remain symbolic. Do not select a Jinja branch or invent
    // values for loops, filters or other template expressions.
    const sql = body
      .replace(/\{#[\s\S]*?#\}/g, "")
      .replace(/\{\{[-+]?\s*([A-Za-z_]\w*)\s*[-+]?\}\}/g, (original: string, parameter: string) =>
        parameters.has(parameter) ? parameter : original
      );
    let summary: BizSummary;
    if (/\{[{%#]/.test(sql)) {
      summary = {
        steps: [{ label: "MACRO", detail: body, card: { primary: name, secondary: "Template logic" } }],
        note: null,
      };
    } else {
      // Macros commonly return a scalar expression rather than a SELECT.
      summary = getSQLBizSummary(sql);
      if (summary.error || !summary.steps.length) summary = getSQLBizSummary(`SELECT ${sql}`);
    }
    if (summary.error) return { steps, note: null, error: `${name}: ${summary.error}` };
    const withoutAnalysis = (step: BizStep): BizStep => ({
      ...step,
      scope: `${name}(${[...parameters].join(", ")})${step.scope ? ` / ${step.scope}` : ""}`,
      filter: undefined,
      filterCards: undefined,
      stats: undefined,
      children: step.children?.map(withoutAnalysis),
    });
    steps.push(...summary.steps.map(withoutAnalysis));
  }
  return { steps, note: steps.length ? null : "No macro declaration yet." };
}
