import { ast, Dialect, parse } from "@polyglot-sql/sdk";
import { mapKnobParameters } from "../Knob/knobSQL";

export type BizStep = { label: string; detail: string };
export type BizSummary = { steps: BizStep[]; note: string | null };

const cache = new Map<string, BizSummary>();
const aggregateNames: Record<string, string> = {
  count: "Count",
  sum: "Total",
  avg: "Average",
  min: "Minimum",
  max: "Maximum",
};
const operators: Record<string, string> = {
  eq: "is",
  neq: "is not",
  gt: "is greater than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  and: "and",
  or: "or",
  add: "+",
  sub: "−",
  mul: "×",
  div: "÷",
  is: "is",
};

// Render only expressions whose meaning we can explain faithfully. Unsupported
// expressions remain visible as a limitation, rather than leaking SQL or guessing.
function describe(expression: ast.Expression, depth = 0): string | null {
  if (depth > 12) return null;
  const child = (value: ast.Expression) => describe(value, depth + 1);
  if ("column" in expression) {
    return [expression.column.table?.name, expression.column.name.name].filter(Boolean).join(".");
  }
  if ("identifier" in expression) return expression.identifier.name;
  if ("literal" in expression) {
    if (typeof expression.literal.value !== "string") return null;
    return expression.literal.literal_type === "string" ? `“${expression.literal.value}”` : expression.literal.value;
  }
  if ("null" in expression) return "missing";
  if ("boolean" in expression) return String(expression.boolean.value);
  if ("table" in expression) {
    const table = expression.table;
    const name = [table.catalog?.name, table.schema?.name, table.name.name].filter(Boolean).join(".");
    return table.alias ? `${name} (${table.alias.name})` : name;
  }
  if ("star" in expression) {
    if (expression.star.except?.length || expression.star.replace?.length || expression.star.rename?.length)
      return null;
    return "all columns";
  }
  if ("alias" in expression) {
    const value = child(expression.alias.this);
    return value ? `${expression.alias.alias.name}: ${value}` : null;
  }
  if ("paren" in expression) {
    const value = child(expression.paren.this);
    return value ? `(${value})` : null;
  }
  if ("not" in expression) {
    const value = child(expression.not.this);
    return value ? `not (${value})` : null;
  }
  if ("neg" in expression) {
    const value = child(expression.neg.this);
    return value ? `−${value}` : null;
  }
  if ("is_null" in expression) {
    const value = child(expression.is_null.this);
    return value ? `${value} is ${expression.is_null.not ? "not " : ""}missing` : null;
  }
  if ("between" in expression) {
    if (expression.between.symmetric) return null;
    const { this: value, low, high } = expression.between;
    const parts = [child(value), child(low), child(high)];
    return parts.every(Boolean)
      ? `${parts[0]} is ${expression.between.not ? "not " : ""}between ${parts[1]} and ${parts[2]}`
      : null;
  }
  if ("in" in expression && !expression.in.query && !expression.in.unnest) {
    const value = child(expression.in.this);
    const values = expression.in.expressions.map(child);
    return value && values.every(Boolean)
      ? `${value} is ${expression.in.not ? "not " : ""}one of ${values.join(", ")}`
      : null;
  }
  const key = ast.getExprType(expression);
  const data = ast.getExprData(expression);
  if (!data || typeof data !== "object") return null;
  if (operators[key] && "left" in data && "right" in data) {
    const left = child(data.left as ast.Expression);
    const right = child(data.right as ast.Expression);
    if (!left || !right) return null;
    return key === "and" || key === "or"
      ? `(${left}) ${operators[key]} (${right})`
      : `${left} ${operators[key]} ${right}`;
  }
  if ("count" in expression) {
    const count = expression.count;
    if (count.filter || count.ignore_nulls != null) return null;
    if (count.star) return "Count rows";
    const value = count.this && child(count.this);
    return value ? `Count ${count.distinct ? "unique " : "non-missing "}${value} values` : null;
  }
  const aggregate =
    "sum" in expression
      ? expression.sum
      : "avg" in expression
        ? expression.avg
        : "min" in expression
          ? expression.min
          : "max" in expression
            ? expression.max
            : null;
  if (aggregate) {
    if (
      aggregate.filter ||
      aggregate.having_max ||
      aggregate.limit ||
      aggregate.ignore_nulls != null ||
      aggregate.order_by.length
    )
      return null;
    const value = child(aggregate.this);
    return value ? `${aggregateNames[key]} of ${aggregate.distinct ? "unique " : ""}${value}` : null;
  }
  return null;
}

function summarize(sql: string): BizSummary {
  if (!sql.trim()) return { steps: [], note: "No query yet. Use the briefcase toggle to write SQL." };
  // Keep controls recognizable without substituting their current values.
  const result = parse(
    mapKnobParameters(sql, (name) => `"{${name}}"`),
    Dialect.DuckDB
  );
  if (!result.success || !Array.isArray(result.ast) || result.ast.length !== 1) {
    return { steps: [], note: "This query cannot be summarized yet. Use the briefcase toggle to inspect the SQL." };
  }
  const root = result.ast[0] as ast.Expression;
  if (!("select" in root)) {
    return {
      steps: [],
      note: "An overview is not available for this query type. Use the briefcase toggle to inspect the SQL.",
    };
  }

  const query = root.select;
  const steps: BizStep[] = [];
  let partial = false;
  const explain = (expression: ast.Expression): string => {
    const description = describe(expression);
    if (description !== null) return description;
    partial = true;
    if ("alias" in expression) return `${expression.alias.alias.name}: calculated value`;
    if ("subquery" in expression) return expression.subquery.alias?.name ?? "a nested query";
    return "an expression (see SQL)";
  };
  const list = (expressions: ast.Expression[]) => expressions.map(explain).join(", ");
  const resolvePosition = (expression: ast.Expression): ast.Expression => {
    if ("literal" in expression && expression.literal.literal_type === "number") {
      const position = Number(expression.literal.value);
      if (Number.isInteger(position) && position > 0 && position <= query.expressions.length) {
        return query.expressions[position - 1];
      }
    }
    return expression;
  };

  if (query.with) {
    partial = true;
    steps.push({
      label: "Prepare",
      detail: `Intermediate queries: ${query.with.ctes.map((cte) => cte.alias.name).join(", ")}`,
    });
  }
  if (query.from) steps.push({ label: "Read", detail: list(query.from.expressions) });
  for (const join of query.joins) {
    const condition = join.on
      ? ` where ${explain(join.on)}`
      : join.using.length
        ? ` matching ${join.using.map((column) => column.name).join(", ")}`
        : "";
    steps.push({ label: "Join", detail: `${join.kind} join with ${explain(join.this)}${condition}` });
  }
  if (query.where_clause) steps.push({ label: "Filter", detail: explain(query.where_clause.this) });

  // A window aggregate retains rows; it must not be described as grouping them.
  const hasWindow = query.expressions.some((expression) => ast.hasWindowFunctions(expression));
  const hasAggregate = query.expressions.some((expression) => {
    const aggregateTypes = new Set(ast.getAggregateFunctions(expression).map(ast.getExprType));
    let nestedDepth = 0;
    let found = false;
    ast.walk(expression, {
      enter(node) {
        if ("window_function" in node || "select" in node || "subquery" in node) nestedDepth++;
        if (!nestedDepth && aggregateTypes.has(ast.getExprType(node))) found = true;
      },
      leave(node) {
        if ("window_function" in node || "select" in node || "subquery" in node) nestedDepth--;
      },
    });
    return found;
  });
  if (query.group_by || hasAggregate) {
    const group = query.group_by;
    const grouping = group
      ? group.all
        ? "combination of non-aggregated fields"
        : list(group.expressions.map(resolvePosition))
      : null;
    steps.push({ label: "Aggregate", detail: grouping ? `One row per ${grouping}` : "Summarize all rows" });
  }
  if (query.having) steps.push({ label: "Filter groups", detail: explain(query.having.this) });
  if (hasWindow) {
    partial = true;
    steps.push({ label: "Window", detail: "Calculate across related rows, keeping individual rows" });
  }
  if (query.qualify) steps.push({ label: "Filter window", detail: explain(query.qualify.this) });
  steps.push({ label: "Select", detail: list(query.expressions) });
  if (query.distinct || query.distinct_on) {
    steps.push({
      label: "Deduplicate",
      detail: query.distinct_on ? `Keep one row per ${list(query.distinct_on)}` : "Keep unique rows",
    });
  }
  if (query.order_by) {
    steps.push({
      label: "Sort",
      detail: query.order_by.expressions
        .map(
          (order) =>
            `${explain(resolvePosition(order.this))} (${order.desc ? "descending" : "ascending"}${order.nulls_first === null ? "" : order.nulls_first ? ", missing first" : ", missing last"})`
        )
        .join(", "),
    });
  }
  if (query.offset) steps.push({ label: "Skip", detail: `${explain(query.offset.this)} rows` });
  if (query.limit) steps.push({ label: "Limit", detail: `Keep up to ${explain(query.limit.this)} rows` });
  if (
    query.sample ||
    query.top ||
    query.fetch ||
    query.prewhere ||
    query.connect ||
    query.into ||
    query.lateral_views.length ||
    query.distribute_by ||
    query.cluster_by ||
    query.sort_by ||
    query.group_by?.totals ||
    query.exclude?.length ||
    query.limit_by?.length
  )
    partial = true;

  return { steps, note: partial ? "Partial overview. Use the briefcase toggle for the full query logic." : null };
}

export function getSQLBizSummary(sql: string): BizSummary {
  const existing = cache.get(sql);
  if (existing) return existing;
  const summary = summarize(sql);
  if (cache.size >= 100) cache.delete(cache.keys().next().value!);
  cache.set(sql, summary);
  return summary;
}

export function getSQLBizFlow(summary: BizSummary): BizStep[] {
  const selection = summary.steps.find((step) => step.label === "Select");
  const hasAggregate = summary.steps.some((step) => step.label === "Aggregate");
  const source = summary.steps.find((step) => step.label === "Read");
  // The source tab already provides context. Keep the main flow focused on
  // transformations, and attach selected metrics to the aggregation step.
  const steps = summary.steps
    .filter(
      (step) => step.label !== "Read" && !(step.label === "Select" && (hasAggregate || step.detail === "all columns"))
    )
    .map((step) =>
      step.label === "Aggregate" && selection ? { ...step, detail: `${step.detail}\n${selection.detail}` } : step
    );
  if (!steps.length) {
    if (source) steps.push(source);
    else if (selection) steps.push(selection);
  } else if (source) {
    steps[0] = { ...steps[0], detail: `Source: ${source.detail}\n${steps[0].detail}` };
  }
  if (steps.length <= 4) return steps;
  const middle = steps.slice(2, -1);
  return [
    ...steps.slice(0, 2),
    { label: `+${middle.length} steps`, detail: middle.map((step) => `${step.label}: ${step.detail}`).join("\n") },
    steps[steps.length - 1],
  ];
}

export function getSQLBizSize(sql: string, width: number, height: number) {
  const summary = getSQLBizSummary(sql);
  return {
    w: Math.min(width, 400),
    h: Math.min(height, summary.note ? 230 : 210),
  };
}
