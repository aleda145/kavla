import { ast, Dialect, generate, parse } from "@polyglot-sql/sdk";
import { mapKnobParameters } from "../Knob/knobSQL";
import { buildBizFilterPlan, getBizFilterConditions, type BizFilterPlan } from "./sqlBizFilterStats";
import {
  buildBizOperationStats,
  buildBizCombineStats,
  buildBizRowLimitStats,
  bizCleaningFunctions as cleaningFunctions,
  type BizOperationStatsPlan,
} from "./sqlBizOperationStats";

export type BizOperation =
  | "CTE"
  | "READ"
  | "JOIN"
  | "FILTER"
  | "CALCULATE"
  | "BUCKET"
  | "CLEAN"
  | "CONDITIONAL"
  | "AGGREGATE"
  | "FILTER GROUPS"
  | "WINDOW"
  | "FILTER WINDOW"
  | "SELECT"
  | "DEDUPLICATE"
  | "SORT"
  | "SKIP"
  | "LIMIT"
  | "COMBINE";
type BizCard = { primary: string; secondary?: string };
export type BizStep = {
  label: BizOperation;
  detail: string;
  scope?: string;
  card?: BizCard;
  cteName?: string;
  children?: BizStep[];
  filter?: BizFilterPlan;
  filterCards?: BizCard[];
  stats?: BizOperationStatsPlan;
};
export type BizSummary = { steps: BizStep[]; note: string | null; error?: string };

const cache = new Map<string, BizSummary>();
type BizGroupLayout = { w: number; h: number; columns: number[] };
const groupLayouts = new WeakMap<BizStep, Map<number, BizGroupLayout>>();
const bucketFunctions = new Set([
  "floor",
  "ceil",
  "ceiling",
  "round",
  "date_trunc",
  "timestamp_trunc",
  "datetime_trunc",
  "time_trunc",
  "time_bucket",
  "date_bin",
  "width_bucket",
]);

function expressionSQL(expression: ast.Expression): string {
  const result = generate([expression], Dialect.DuckDB);
  if (!result.success || !result.sql?.[0] || result.sql[0].includes("/* unsupported expression */")) {
    throw new Error(result.error ?? `Cannot render SQL expression: ${ast.getExprType(expression)}`);
  }
  return result.sql[0].trim().replace(/"\{([A-Za-z_][A-Za-z0-9_]*)\}"/g, "{$1}");
}

function unalias(expression: ast.Expression): ast.Expression {
  return "alias" in expression ? expression.alias.this : expression;
}

function assignment(expression: ast.Expression): string {
  return "alias" in expression
    ? `${expressionSQL({ identifier: expression.alias.alias })} = ${expressionSQL(expression.alias.this)}`
    : expressionSQL(expression);
}

function metricCaption(expression: ast.Expression): string {
  return "alias" in expression
    ? `${expressionSQL(expression.alias.this)} → ${expressionSQL({ identifier: expression.alias.alias })}`
    : expressionSQL(expression);
}

function transformCard(expression: ast.Expression, label: BizOperation): BizCard {
  const value = unalias(expression);
  const columns = [...new Set(ast.getColumns(value).map(expressionSQL))];
  const input = columns.slice(0, 2).join(", ") + (columns.length > 2 ? ` +${columns.length - 2}` : "");
  const output = "alias" in expression ? expressionSQL({ identifier: expression.alias.alias }) : "";
  const primary =
    input && output && input !== output ? `${input} → ${output}` : output || input || expressionSQL(value);
  let secondary = expressionSQL(value);
  if (label === "CONDITIONAL" && "case" in value) {
    const results = value.case.whens.map(([, result]) => result);
    if (value.case.else_) results.push(value.case.else_);
    const constants = results.every((result) => "literal" in result || "boolean" in result || "null" in result);
    secondary =
      constants && value.case.else_
        ? `${new Set(results.map(expressionSQL)).size} groups`
        : `${value.case.whens.length} rules`;
  } else if (label === "CONDITIONAL" && "if_func" in value) {
    secondary = expressionSQL(value.if_func.condition);
  } else if (label === "BUCKET") {
    const floor =
      "floor" in value ? value.floor : "mul" in value && "floor" in value.mul.left ? value.mul.left.floor : null;
    if (
      floor &&
      "div" in floor.this &&
      "literal" in floor.this.div.right &&
      floor.this.div.right.literal.literal_type === "number" &&
      Number(floor.this.div.right.literal.value) > 0
    ) {
      secondary = `${expressionSQL(floor.this.div.right)}-wide bins`;
    }
  }
  return { primary, secondary };
}

function conditionCard(expression: ast.Expression): BizCard {
  const detail = expressionSQL(expression);
  if (detail.length <= 44) return { primary: detail };
  const columns = [...new Set(ast.getColumns(expression).map(expressionSQL))];
  const logical = ast.findAll(expression, (node) => "and" in node || "or" in node).length;
  return {
    primary: columns.length
      ? columns.slice(0, 2).join(", ") + (columns.length > 2 ? ` +${columns.length - 2}` : "")
      : detail,
    secondary: logical ? `${logical + 1} conditions` : detail,
  };
}

function isPlainProjection(expression: ast.Expression) {
  const value = unalias(expression);
  return (
    "column" in value ||
    "identifier" in value ||
    "star" in value ||
    "literal" in value ||
    "boolean" in value ||
    "null" in value
  );
}

function outputProjection(expression: ast.Expression): string {
  return "alias" in expression && !isPlainProjection(expression)
    ? expressionSQL({ identifier: expression.alias.alias })
    : expressionSQL(expression);
}

function expressionFacts(expression: ast.Expression) {
  const aggregateNodes = ast.getAggregateFunctions(expression);
  const aggregateTypes = new Set(aggregateNodes.map(ast.getExprType));
  const aggregateKeys = new Set(aggregateNodes.map((node) => JSON.stringify(node)));
  const aggregates: ast.Expression[] = [];
  const windows: ast.Expression[] = [];
  const functions = new Set<string>();
  let nestedQueryDepth = 0;
  ast.walk(expression, {
    enter(node, parent) {
      if ("select" in node || "subquery" in node) nestedQueryDepth++;
      if (nestedQueryDepth) return;
      const type = ast.getExprType(node);
      functions.add("function" in node ? node.function.name.toLowerCase() : type);
      if ("window_function" in node) windows.push(node);
      // A window aggregate retains rows; it must not be described as grouping them.
      // In SUM(SUM(x)) OVER (), only the inner SUM is a grouping aggregate.
      const isWindowCall = parent && "window_function" in parent && parent.window_function.this === node;
      if (aggregateTypes.has(type) && aggregateKeys.has(JSON.stringify(node)) && !isWindowCall) aggregates.push(node);
    },
    leave(node) {
      if ("select" in node || "subquery" in node) nestedQueryDepth--;
    },
  });
  return { aggregates, windows, functions };
}

function transformation(functions: Set<string>): BizOperation {
  if (["case", "if_func", "if", "iff"].some((name) => functions.has(name))) return "CONDITIONAL";
  if ([...bucketFunctions].some((name) => functions.has(name))) return "BUCKET";
  if ([...cleaningFunctions].some((name) => functions.has(name))) return "CLEAN";
  return "CALCULATE";
}

function setOperation(expression: ast.Expression) {
  if ("union" in expression) return { name: "UNION", query: expression.union };
  if ("intersect" in expression) return { name: "INTERSECT", query: expression.intersect };
  if ("except" in expression) return { name: "EXCEPT", query: expression.except };
  return null;
}

function sourceName(expression: ast.Expression): string {
  if ("subquery" in expression) {
    return expression.subquery.alias
      ? expressionSQL({ identifier: expression.subquery.alias })
      : sourceName(expression.subquery.this);
  }
  if ("select" in expression) {
    return expression.select.from?.expressions.map(sourceName).join(", ") || "values";
  }
  const combined = setOperation(expression);
  if (combined)
    return `(${sourceName(combined.query.left)} ${combined.name}${combined.query.all ? " ALL" : ""} ${sourceName(combined.query.right)})`;
  return expressionSQL(expression);
}

function rowCount(value: string) {
  return `${value} ${value === "1" ? "row" : "rows"}`;
}

function fetchDetails(fetch: ast.ExpressionInner<"fetch">) {
  const count = fetch.count ? expressionSQL(fetch.count) : "1";
  return `${fetch.percent ? `${count}%` : rowCount(count)}${fetch.with_ties ? " WITH TIES" : ""}`;
}

function summarize(sql: string): BizSummary {
  if (!sql.trim()) return { steps: [], note: "No query yet." };
  // Keep controls recognizable without substituting their current values.
  const result = parse(
    mapKnobParameters(sql, (name) => `"{${name}}"`),
    Dialect.DuckDB
  );
  if (!result.success) return { steps: [], note: null, error: result.error ?? "SQL parsing failed." };
  if (!Array.isArray(result.ast) || result.ast.length !== 1) {
    return { steps: [], note: "The pipeline supports one query at a time." };
  }
  const steps: BizStep[] = [];
  const add = (label: BizOperation, detail: string, scope?: string, card?: BizCard) =>
    steps.push({ label, detail, scope, card });
  const list = (expressions: ast.Expression[]) => expressions.map(expressionSQL).join(", ");
  const scoped = (scope: string | undefined, child: string) => (scope ? `${scope} / ${child}` : child);

  const appendQuery = (
    expression: ast.Expression,
    scope?: string,
    depth = 0,
    filterScopes: ast.ExpressionInner<"with">[] = []
  ): void => {
    if (depth > 30) throw new Error("Query nesting exceeds the pipeline depth limit (30).");
    if ("subquery" in expression) {
      const subquery = expression.subquery;
      appendQuery(subquery.this, scope, depth + 1, filterScopes);
      if (subquery.order_by) add("SORT", sortDetails(subquery.order_by), scope, sortCard(subquery.order_by));
      if (subquery.offset) {
        add("SKIP", rowCount(expressionSQL(subquery.offset.this)), scope);
        steps[steps.length - 1].stats = buildBizRowLimitStats(expression, filterScopes, "skip");
      }
      if (subquery.limit) {
        add("LIMIT", rowCount(expressionSQL(subquery.limit.this)), scope);
        steps[steps.length - 1].stats = buildBizRowLimitStats(expression, filterScopes, "limit");
      }
      return;
    }
    const combined = setOperation(expression);
    const query = "select" in expression ? expression.select : null;
    if (!combined && !query) {
      add("READ", expressionSQL(expression), scope);
      return;
    }
    const withClause = query?.with ?? combined?.query.with;
    for (const [cteIndex, cte] of (withClause?.ctes ?? []).entries()) {
      const name = expressionSQL({ identifier: cte.alias });
      const columns = cte.columns.length
        ? ` (${cte.columns.map((column) => expressionSQL({ identifier: column })).join(", ")})`
        : "";
      const start = steps.length;
      appendQuery(
        cte.this,
        scoped(scope, `${withClause?.recursive ? "Recursive CTE" : "CTE"} ${name}${columns}`),
        depth + 1,
        [...filterScopes, { ...withClause!, ctes: withClause!.ctes.slice(0, cteIndex) }]
      );
      const children = steps.splice(start);
      steps.push({
        label: "CTE",
        detail: expressionSQL(cte.this),
        scope,
        cteName: cte.alias.name,
        card: { primary: `${name}${columns}` },
        children,
      });
    }
    if (combined) {
      const { query: operation, name } = combined;
      // Polyglot attaches trailing FETCH to the unparenthesized right SELECT.
      // It limits the combined result; a parenthesized branch keeps its own FETCH.
      const fetch = "select" in operation.right ? operation.right.select.fetch : null;
      const right: ast.Expression =
        fetch && "select" in operation.right ? { select: { ...operation.right.select, fetch: null } } : operation.right;
      const branchScopes = withClause ? [...filterScopes, withClause] : filterScopes;
      appendQuery(operation.left, scoped(scope, `Left: ${sourceName(operation.left)}`), depth + 1, branchScopes);
      appendQuery(right, scoped(scope, `Right: ${sourceName(operation.right)}`), depth + 1, branchScopes);
      const modifiers = `${operation.all ? " ALL" : operation.distinct ? " DISTINCT" : ""}${operation.by_name ? " BY NAME" : ""}${operation.corresponding ? " CORRESPONDING" : ""}`;
      const connector = name === "EXCEPT" ? "−" : name === "INTERSECT" ? "∩" : "+";
      add(
        "COMBINE",
        `${name}${modifiers} · ${sourceName(operation.left)} ${connector} ${sourceName(operation.right)}`,
        scope,
        {
          primary: `${name}${modifiers}`,
          secondary: `${sourceName(operation.left)} ${connector} ${sourceName(operation.right)}`,
        }
      );
      steps[steps.length - 1].stats = buildBizCombineStats(expression, filterScopes, result.ast![0]);
      if (operation.order_by) add("SORT", sortDetails(operation.order_by), scope, sortCard(operation.order_by));
      if (operation.offset) {
        add("SKIP", rowCount(expressionSQL(operation.offset)), scope);
        steps[steps.length - 1].stats = buildBizRowLimitStats(expression, filterScopes, "skip");
      }
      if (operation.limit) {
        add("LIMIT", rowCount(expressionSQL(operation.limit)), scope);
        steps[steps.length - 1].stats = buildBizRowLimitStats(expression, filterScopes, "limit");
      }
      if (fetch) {
        add("LIMIT", fetchDetails(fetch), scope);
        steps[steps.length - 1].stats = buildBizRowLimitStats(expression, filterScopes, "limit");
      }
      return;
    }
    if (!query) return;

    const resolvePosition = (value: ast.Expression): ast.Expression => {
      if ("literal" in value && value.literal.literal_type === "number") {
        const position = Number(value.literal.value);
        if (Number.isInteger(position) && position > 0 && position <= query.expressions.length) {
          return unalias(query.expressions[position - 1]);
        }
      }
      return value;
    };
    for (const source of [...(query.from?.expressions ?? []), ...query.joins.map((join) => join.this)]) {
      if ("subquery" in source)
        appendQuery(
          source,
          scoped(scope, `Subquery ${sourceName(source)}`),
          depth + 1,
          withClause ? [...filterScopes, withClause] : filterScopes
        );
    }
    if (query.from) add("READ", query.from.expressions.map(sourceName).join(", "), scope);
    for (const [index, join] of query.joins.entries()) {
      const kind = join.kind.replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase();
      const condition = join.on
        ? ` ON ${expressionSQL(join.on)}`
        : join.using.length
          ? ` USING (${join.using.map((column) => expressionSQL({ identifier: column })).join(", ")})`
          : "";
      add("JOIN", `${kind} ${sourceName(join.this)}${condition}`, scope, {
        primary: `${kind} ${sourceName(join.this)}`,
        secondary: condition.trim() || undefined,
      });
      steps[steps.length - 1].stats = buildBizOperationStats(query, filterScopes, { kind: "join", index });
    }
    if (query.where_clause) {
      add("FILTER", expressionSQL(query.where_clause.this), scope, conditionCard(query.where_clause.this));
      steps[steps.length - 1].filter = buildBizFilterPlan(query, filterScopes);
      const conditions = getBizFilterConditions(query.where_clause.this);
      if (conditions.length > 1) {
        steps[steps.length - 1].filterCards = conditions.map((condition) => ({
          primary: conditionCard(condition).primary,
          secondary: `+${conditions.length - 1} ${conditions.length === 2 ? "condition" : "conditions"}`,
        }));
      }
    }

    const projections = query.expressions.map((expression) => ({ expression, ...expressionFacts(expression) }));
    const aggregates = new Set<string>();
    for (const projection of projections) {
      if (projection.aggregates.length && !projection.windows.length) aggregates.add(assignment(projection.expression));
      else for (const aggregate of projection.aggregates) aggregates.add(expressionSQL(aggregate));
    }
    // HAVING and ORDER BY can aggregate even when the result does not project a metric.
    for (const clause of [
      query.having?.this,
      query.qualify?.this,
      ...(query.order_by?.expressions.map((order) => order.this) ?? []),
    ]) {
      if (clause)
        for (const aggregate of expressionFacts(clause).aggregates) {
          const detail = expressionSQL(aggregate);
          if (![...aggregates].some((existing) => existing === detail || existing.endsWith(` = ${detail}`)))
            aggregates.add(detail);
        }
    }
    const transforms = projections.filter(
      (projection) =>
        !isPlainProjection(projection.expression) && !projection.aggregates.length && !projection.windows.length
    );
    const groupingExpressions = query.group_by?.expressions.map(resolvePosition) ?? [];
    const groupKeys = new Set(groupingExpressions.map(expressionSQL));
    const groupNames = new Set(
      groupingExpressions.flatMap((expression) =>
        "column" in expression ? [expression.column.name.name.toLowerCase()] : []
      )
    );
    const aliases = new Map(
      projections.flatMap((projection) =>
        "alias" in projection.expression
          ? [[projection.expression.alias.alias.name.toLowerCase(), projection] as const]
          : []
      )
    );
    const needsAggregateOrWindow = (
      projection: (typeof projections)[number],
      visited = new Set<ast.Expression>()
    ): boolean => {
      if (projection.aggregates.length || projection.windows.length) return true;
      if (visited.has(projection.expression)) return false;
      visited.add(projection.expression);
      return ast.getColumns(unalias(projection.expression)).some((node) => {
        if (!("column" in node) || node.column.table) return false;
        const dependency = aliases.get(node.column.name.name.toLowerCase());
        return dependency && dependency !== projection ? needsAggregateOrWindow(dependency, visited) : false;
      });
    };
    const early = transforms.filter((projection) => {
      const { expression } = projection;
      return (
        !needsAggregateOrWindow(projection) &&
        ((!query.group_by && !aggregates.size) ||
          query.group_by?.all ||
          groupKeys.has(expressionSQL(unalias(expression))) ||
          ("alias" in expression && groupNames.has(expression.alias.alias.name.toLowerCase())))
      );
    });
    const appendTransforms = (items: typeof transforms, beforeAggregation: boolean) => {
      for (const item of items) {
        const label = transformation(item.functions);
        add(label, assignment(item.expression), scope, transformCard(item.expression, label));
        if (label === "BUCKET" || label === "CONDITIONAL" || label === "CLEAN") {
          steps[steps.length - 1].stats = buildBizOperationStats(query, filterScopes, {
            kind: label === "CLEAN" ? "clean" : "buckets",
            expression: item.expression,
            beforeAggregation,
          });
        }
      }
    };
    appendTransforms(early, true);
    if (query.group_by || aggregates.size) {
      const group = query.group_by && { ...query.group_by, expressions: groupingExpressions };
      const grouping = group ? expressionSQL({ group_by: group }) : "";
      const metrics = projections
        .filter((projection) => projection.aggregates.length && !projection.windows.length)
        .map((projection) => metricCaption(projection.expression));
      const captions = metrics.length ? metrics : [...aggregates];
      const caption = captions.length
        ? captions[0] + (captions.length > 1 ? ` · +${captions.length - 1}` : "")
        : undefined;
      add("AGGREGATE", [grouping, ...aggregates].filter(Boolean).join(" · "), scope, {
        primary: grouping ? grouping.replace(/^GROUP BY /, "BY ") : (caption ?? "All rows"),
        secondary: grouping ? caption : undefined,
      });
      steps[steps.length - 1].stats = buildBizOperationStats(query, filterScopes, { kind: "aggregate" });
    }
    if (query.having) {
      add("FILTER GROUPS", `HAVING ${expressionSQL(query.having.this)}`, scope, conditionCard(query.having.this));
      steps[steps.length - 1].stats = buildBizOperationStats(query, filterScopes, { kind: "having" });
    }
    for (const projection of projections) {
      if (projection.windows.length) {
        const window = projection.windows[0];
        const over = "window_function" in window ? window.window_function.over : null;
        const fn = "window_function" in window ? expressionSQL(window.window_function.this) : expressionSQL(window);
        const output =
          "alias" in projection.expression ? expressionSQL({ identifier: projection.expression.alias.alias }) : "";
        add("WINDOW", assignment(projection.expression), scope, {
          primary: output ? `${fn} → ${output}` : fn,
          secondary: over?.partition_by.length
            ? `BY ${list(over.partition_by)}`
            : over?.order_by.length
              ? `ORDER ${expressionSQL(over.order_by[0].this)}`
              : undefined,
        });
      }
    }
    const displayedWindows = new Set(projections.flatMap((projection) => projection.windows.map(expressionSQL)));
    for (const clause of [query.qualify?.this, ...(query.order_by?.expressions.map((order) => order.this) ?? [])]) {
      if (clause)
        for (const window of expressionFacts(clause).windows) {
          const detail = expressionSQL(window);
          if (!displayedWindows.has(detail)) {
            add("WINDOW", detail, scope);
            displayedWindows.add(detail);
          }
        }
    }
    if (query.windows?.length) {
      for (const window of query.windows) {
        const definition =
          window.spec.partition_by.length || window.spec.order_by.length || window.spec.frame
            ? expressionSQL({ window: window.spec })
            : "";
        const base = window.spec.window_name ? expressionSQL({ identifier: window.spec.window_name }) : "";
        add(
          "WINDOW",
          `${expressionSQL({ identifier: window.name })} AS (${[base, definition].filter(Boolean).join(" ")})`,
          scope
        );
      }
    }
    appendTransforms(
      transforms.filter((projection) => !early.includes(projection)),
      false
    );
    if (query.qualify) {
      add("FILTER WINDOW", expressionSQL(query.qualify.this), scope, conditionCard(query.qualify.this));
      steps[steps.length - 1].stats = buildBizOperationStats(query, filterScopes, { kind: "qualify" });
    }
    add("SELECT", query.expressions.map(outputProjection).join(", "), scope);
    if (query.distinct || query.distinct_on) {
      add(
        "DEDUPLICATE",
        query.distinct_on
          ? `DISTINCT ON (${list(query.distinct_on)})`
          : `DISTINCT ${query.expressions.map(outputProjection).join(", ")}`,
        scope
      );
      steps[steps.length - 1].stats = buildBizOperationStats(query, filterScopes, { kind: "deduplicate" });
    }
    if (query.order_by)
      add("SORT", sortDetails(query.order_by, resolvePosition), scope, sortCard(query.order_by, resolvePosition));
    if (query.offset) {
      add("SKIP", rowCount(expressionSQL(query.offset.this)), scope);
      steps[steps.length - 1].stats = buildBizOperationStats(query, filterScopes, { kind: "skip" });
    }
    if (query.limit) {
      add("LIMIT", rowCount(expressionSQL(query.limit.this)), scope);
      steps[steps.length - 1].stats = buildBizOperationStats(query, filterScopes, { kind: "limit" });
    }
    if (query.fetch) {
      add("LIMIT", fetchDetails(query.fetch), scope);
      steps[steps.length - 1].stats = buildBizOperationStats(query, filterScopes, { kind: "limit" });
    }
    if (query.top) {
      const count = expressionSQL(query.top.this);
      add(
        "LIMIT",
        `${query.top.percent ? `${count}%` : rowCount(count)}${query.top.with_ties ? " WITH TIES" : ""}`,
        scope
      );
      steps[steps.length - 1].stats = buildBizOperationStats(query, filterScopes, { kind: "limit" });
    }
  };
  try {
    const root = result.ast[0] as ast.Expression;
    if (!("select" in root) && !("subquery" in root) && !setOperation(root)) {
      return { steps: [], note: "Switch to SQL to inspect this statement." };
    }
    appendQuery(root);
    return { steps, note: null };
  } catch (error) {
    return { steps, note: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function sortDetails(order: ast.ExpressionInner<"order_by">, resolve = (expression: ast.Expression) => expression) {
  return order.expressions
    .map(
      (item) =>
        `${expressionSQL(resolve(item.this))} ${item.desc ? "DESC" : "ASC"}${item.nulls_first == null ? "" : item.nulls_first ? " NULLS FIRST" : " NULLS LAST"}`
    )
    .join(", ");
}

function sortCard(
  order: ast.ExpressionInner<"order_by">,
  resolve = (expression: ast.Expression) => expression
): BizCard {
  const first = order.expressions[0];
  return {
    primary: first ? sortDetails({ ...order, expressions: [first] }, resolve) : "",
    secondary:
      order.expressions.length > 1
        ? `+${order.expressions.length - 1} sort ${order.expressions.length === 2 ? "field" : "fields"}`
        : undefined,
  };
}

export function getSQLBizSummary(sql: string): BizSummary {
  const existing = cache.get(sql);
  if (existing) return existing;
  const summary = summarize(sql);
  const visibleSteps = (items: BizStep[]): BizStep[] => {
    const steps = items.filter((step) => step.label !== "READ");
    for (const step of steps) {
      // An unavailable analysis adds no stats UI. Query execution errors still
      // come through the analysis hooks when a supported plan is run.
      if (step.filter && "error" in step.filter) delete step.filter;
      if (step.stats && "error" in step.stats) delete step.stats;
      if (step.children) step.children = visibleSteps(step.children);
    }
    return steps.some((step) => step.label !== "SELECT") ? steps.filter((step) => step.label !== "SELECT") : steps;
  };
  summary.steps = visibleSteps(summary.steps);
  if (cache.size >= 100) cache.delete(cache.keys().next().value!);
  cache.set(sql, summary);
  return summary;
}

export function getSQLBizStep(summary: BizSummary, path: readonly number[]): BizStep | undefined {
  let steps = summary.steps;
  let step: BizStep | undefined;
  for (const index of path) {
    step = steps[index];
    if (!step) return undefined;
    steps = step.children ?? [];
  }
  return step;
}

export function getSQLBizFilterPreview(step: BizStep, removed?: readonly number[]): BizCard {
  const fallback = step.card ?? { primary: step.detail };
  if (!step.filterCards?.length || removed?.length !== step.filterCards.length) return fallback;
  // Every condition uses the same input denominator. Ties retain SQL order.
  const first = removed.reduce((best, count, index) => (count > removed[best] ? index : best), 0);
  return step.filterCards[first];
}

export function getSQLBizCardWidth(step: BizStep, availableWidth = Infinity): number {
  if (step.children) return getSQLBizGroupLayout(step, availableWidth).w;
  const cards = [step.card ?? { primary: step.detail }, ...(step.filterCards ?? [])];
  // Match the monospace card text, leaving room for padding and borders.
  const primaryWidth =
    Math.max(...cards.flatMap((card) => card.primary.split("\n").map((line) => Array.from(line).length))) * 7.3;
  const secondaryWidth =
    Math.max(0, ...cards.flatMap((card) => (card.secondary ?? "").split("\n").map((line) => Array.from(line).length))) *
    6.1;
  return Math.ceil(Math.max(132, primaryWidth + 24, secondaryWidth + 24));
}

export const SQL_BIZ_CARD_GAP = 12;

export function getSQLBizCardHeight(step: BizStep, availableWidth = Infinity): number {
  if (step.children) return getSQLBizGroupLayout(step, availableWidth).h;
  const cards = [step.card ?? { primary: step.detail }, ...(step.filterCards ?? [])];
  return Math.max(
    82,
    ...cards.map(
      (card) =>
        52 +
        card.primary.split("\n").length * 16 +
        (card.secondary && !(step.stats && step.label === "CONDITIONAL" && /^\d+ groups$/.test(card.secondary))
          ? 3 + card.secondary.split("\n").length * 14
          : 0) +
        (step.filter || step.stats ? 32 : 0) +
        (step.scope ? 18 : 0)
    )
  );
}

export function getSQLBizColumns(summary: BizSummary, available: { w: number; h: number }): number[] {
  const widths = summary.steps.map((step) => getSQLBizCardWidth(step, available.w));
  if (!widths.length) return [];
  const heights = summary.steps.map((step) => getSQLBizCardHeight(step, available.w));
  const gaps = (widths.length - 1) * SQL_BIZ_CARD_GAP;
  const widest = Math.max(...widths);
  const horizontalFits =
    widths.reduce((sum, width) => sum + width, 0) + gaps <= available.w && Math.max(...heights) <= available.h;
  const verticalFits = widest <= available.w && heights.reduce((sum, height) => sum + height, 0) + gaps <= available.h;

  if (horizontalFits && (!verticalFits || available.w >= available.h)) return widths;
  if (verticalFits) return [widest];

  // Fill rows left to right, using as many columns as the available width permits.
  for (let count = widths.length; count >= 2; count--) {
    const columns = Array<number>(count).fill(0);
    widths.forEach((width, index) => {
      columns[index % count] = Math.max(columns[index % count], width);
    });
    if (columns.reduce((sum, width) => sum + width, 0) + (count - 1) * SQL_BIZ_CARD_GAP <= available.w) {
      return columns;
    }
  }
  return [widest];
}

export function getSQLBizGroupLayout(step: BizStep, availableWidth: number): BizGroupLayout {
  const cached = groupLayouts.get(step);
  const existing = cached?.get(availableWidth);
  if (existing) return existing;
  const children = step.children ?? [];
  const innerWidth = Math.max(0, availableWidth - 24);
  const columns = getSQLBizColumns({ steps: children, note: null }, { w: innerWidth, h: 0 });
  const rows: number[] = [];
  children.forEach((child, index) => {
    const row = Math.floor(index / columns.length);
    rows[row] = Math.max(rows[row] ?? 0, getSQLBizCardHeight(child, innerWidth));
  });
  const layout = {
    w: Math.max(
      160,
      (step.card?.primary.length ?? 0) * 7.3 + 76,
      columns.reduce((sum, width) => sum + width, 0) + Math.max(0, columns.length - 1) * SQL_BIZ_CARD_GAP + 24
    ),
    h: 54 + rows.reduce((sum, height) => sum + height, 0) + Math.max(0, rows.length - 1) * SQL_BIZ_CARD_GAP,
    columns,
  };
  const sizes = cached ?? new Map<number, BizGroupLayout>();
  if (sizes.size >= 8) sizes.delete(sizes.keys().next().value!);
  sizes.set(availableWidth, layout);
  groupLayouts.set(step, sizes);
  return layout;
}
