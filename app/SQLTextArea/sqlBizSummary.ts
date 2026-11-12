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
export const SQL_BIZ_PREVIEW_LIMIT = 3;

function previewLines(items: string[]): string | undefined {
  if (!items.length) return undefined;
  return [
    ...items.slice(0, SQL_BIZ_PREVIEW_LIMIT),
    ...(items.length > SQL_BIZ_PREVIEW_LIMIT ? [`+${items.length - SQL_BIZ_PREVIEW_LIMIT} more`] : []),
  ].join("\n");
}

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

function columnCaption(expressions: ast.Expression[], fallback: string): string {
  const columns = [...new Set(expressions.flatMap((expression) => ast.getColumns(expression).map(expressionSQL)))];
  return columns.length
    ? columns.slice(0, 2).join(", ") + (columns.length > 2 ? ` +${columns.length - 2}` : "")
    : fallback;
}

function outputCaption(expression: ast.Expression): string {
  return "alias" in expression
    ? expressionSQL({ identifier: expression.alias.alias })
    : columnCaption([expression], "Calculated value");
}

function shortPreview(sql: string, fallback: string): string {
  return sql.length <= 80 && !sql.includes("\n") ? sql : fallback;
}

function shortExpression(expression: ast.Expression, fallback: string): string {
  return shortPreview(expressionSQL(expression), fallback);
}

function bucketCaption(value: ast.Expression): string {
  if ("function" in value) {
    const { name, args } = value.function;
    if (["date_trunc", "timestamp_trunc", "datetime_trunc", "time_trunc"].includes(name.toLowerCase())) {
      const unit = args[0];
      if (unit && "literal" in unit && unit.literal.literal_type === "string") {
        const captions: Record<string, string> = {
          year: "Yearly",
          quarter: "Quarterly",
          month: "Monthly",
          week: "Weekly",
          day: "Daily",
          hour: "Hourly",
          minute: "By minute",
          second: "By second",
        };
        const caption = captions[unit.literal.value.toLowerCase()];
        if (caption) return caption;
      }
    }
    if (["time_bucket", "date_bin"].includes(name.toLowerCase())) {
      const width = args[0];
      if (width && "interval" in width) {
        const amount = width.interval.this;
        const unit = width.interval.unit;
        if (
          amount &&
          "literal" in amount &&
          (amount.literal.literal_type === "string" || amount.literal.literal_type === "number")
        ) {
          const alignment = args.length > 2 ? " · custom alignment" : "";
          if (!unit) return `${amount.literal.value} per bin${alignment}`;
          if (unit.type === "simple") {
            return `${amount.literal.value} ${unit.unit.toLowerCase()}${amount.literal.value === "1" ? "" : "s"} per bin${alignment}`;
          }
        }
        return `${shortExpression(width, "Time interval")} bins`;
      }
    }
    if (name.toLowerCase() === "round") {
      const scale = args[1];
      if (!scale) return "Rounded to whole numbers";
      if ("literal" in scale && scale.literal.literal_type === "number" && Number(scale.literal.value) >= 0) {
        return `Rounded to ${scale.literal.value} decimal places`;
      }
    }
  }
  const floor =
    "floor" in value ? value.floor : "mul" in value && "floor" in value.mul.left ? value.mul.left.floor : null;
  if (
    floor &&
    !floor.scale &&
    "div" in floor.this &&
    "literal" in floor.this.div.right &&
    floor.this.div.right.literal.literal_type === "number" &&
    Number(floor.this.div.right.literal.value) > 0
  ) {
    const width = floor.this.div.right;
    if (!("mul" in value)) return `Bin index · width ${expressionSQL(width)}`;
    if ("literal" in value.mul.right && value.mul.right.literal.value === width.literal.value) {
      return `${expressionSQL(width)}-wide bins`;
    }
  }
  return shortExpression(value, "Bucket calculation");
}

function transformCard(expression: ast.Expression, label: BizOperation): BizCard {
  const value = unalias(expression);
  const input = columnCaption([value], "");
  const output = "alias" in expression ? expressionSQL({ identifier: expression.alias.alias }) : "";
  const primary = input && output && input !== output ? `${input} → ${output}` : output || input || "Calculated value";
  let secondary: string | undefined;
  if (label === "CONDITIONAL" && "case" in value) {
    const rules = value.case.whens.map(([condition, result]) => {
      const predicate: ast.Expression = value.case.operand
        ? {
            eq: {
              left: value.case.operand,
              right: condition,
              left_comments: [],
              operator_comments: [],
              trailing_comments: [],
            },
          }
        : condition;
      return shortPreview(
        `${shortExpression(predicate, "Condition")} → ${shortExpression(result, "Calculated result")}`,
        "Complex rule"
      );
    });
    rules.push(
      value.case.else_ ? `Otherwise → ${shortExpression(value.case.else_, "Calculated result")}` : "Otherwise → NULL"
    );
    secondary = previewLines(rules);
  } else if (label === "CONDITIONAL" && "if_func" in value) {
    secondary = previewLines([
      `${shortExpression(value.if_func.condition, "Condition")} → ${shortExpression(value.if_func.true_value, "Calculated result")}`,
      `Otherwise → ${value.if_func.false_value ? shortExpression(value.if_func.false_value, "Calculated result") : "NULL"}`,
    ]);
  } else if (label === "BUCKET") {
    secondary = bucketCaption(value);
  } else if (label === "CALCULATE") {
    const formula = assignment(expression);
    return { primary: shortPreview(formula, primary), secondary: formula.length > 80 ? "Calculation" : undefined };
  } else {
    secondary = shortExpression(value, label === "CLEAN" ? "Cleaning transformation" : "Conditional calculation");
  }
  return { primary, secondary };
}

function conditionCard(expression: ast.Expression): BizCard {
  return {
    primary: previewLines(getBizFilterConditions(expression).map(expressionSQL)) ?? "Row condition",
  };
}

function windowContext(over: ast.ExpressionInner<"window_function">["over"]): string[] {
  const lines: string[] = [];
  if (over.window_name) lines.push(`Window ${expressionSQL({ identifier: over.window_name })}`);
  lines.push(...over.partition_by.map((field) => `Within ${shortExpression(field, "Calculated group")}`));
  lines.push(
    ...over.order_by.map(
      (order) =>
        `By ${shortExpression(order.this, "Calculated value")} ${order.desc ? "↓" : "↑"}${order.nulls_first == null ? "" : order.nulls_first ? " · NULLs first" : " · NULLs last"}`
    )
  );
  if (over.frame) {
    const bound = (value: NonNullable<typeof over.frame>["start"]): string => {
      if (value === "CurrentRow") return "current row";
      if (value === "UnboundedPreceding") return "start";
      if (value === "UnboundedFollowing") return "end";
      if (value === "BarePreceding") return "preceding";
      if (value === "BareFollowing") return "following";
      if ("Preceding" in value) return `${shortExpression(value.Preceding, "N")} preceding`;
      if ("Following" in value) return `${shortExpression(value.Following, "N")} following`;
      return shortExpression(value.Value, "Bound");
    };
    lines.push(
      `${over.frame.kind}: ${bound(over.frame.start)} → ${over.frame.end ? bound(over.frame.end) : "current row"}`
    );
    if (over.frame.exclude)
      lines.push(`Exclude ${over.frame.exclude.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()}`);
  }
  return lines;
}

function windowCard(expression: ast.Expression, definitions: ast.ExpressionInner<"select">["windows"]): BizCard {
  const value = unalias(expression);
  const window = ast.findAll(value, (node) => "window_function" in node)[0];
  const fn = window && "window_function" in window ? window.window_function.this : value;
  const name = "function" in fn ? fn.function.name.toLowerCase() : ast.getExprType(fn);
  const captions: Record<string, string> = {
    row_number: "Row number",
    rank: "Rank",
    dense_rank: "Dense rank",
    percent_rank: "Percentile rank",
    cume_dist: "Cumulative distribution",
    ntile: "Ranked groups",
    n_tile: "Ranked groups",
    lag: "Previous value",
    lead: "Next value",
    first_value: "First value",
    last_value: "Last value",
    nth_value: "Nth value",
    sum: "Sum over window",
    avg: "Average over window",
    count: "Count over window",
    min: "Minimum over window",
    max: "Maximum over window",
  };
  const context: string[] = [];
  if (window && "window_function" in window) {
    let over = window.window_function.over;
    const visited = new Set<string>();
    while (over.window_name && !visited.has(over.window_name.name)) {
      visited.add(over.window_name.name);
      const definition = definitions?.find((item) => item.name.name === over.window_name?.name);
      if (!definition) break;
      over = {
        ...over,
        window_name: definition.spec.window_name,
        partition_by: over.partition_by.length ? over.partition_by : definition.spec.partition_by,
        order_by: over.order_by.length ? over.order_by : definition.spec.order_by,
        frame: over.frame ?? definition.spec.frame,
      };
    }
    context.push(...windowContext(over));
  }
  const input = columnCaption([fn], "");
  const description = `${captions[name] ?? "Window calculation"}${input ? ` · ${input}` : ""}`;
  return {
    primary: outputCaption(expression),
    secondary: [description, previewLines(context)].filter(Boolean).join("\n"),
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
          primary:
            name === "EXCEPT" ? "Exclude matching rows" : name === "INTERSECT" ? "Keep matching rows" : "Combine rows",
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
        primary: `${kind} JOIN · ${sourceName(join.this)}`,
        secondary: join.on
          ? previewLines(
              getBizFilterConditions(join.on).map((predicate) => shortExpression(predicate, "Matching condition"))
            )
          : join.using.length
            ? previewLines(join.using.map((column) => `${expressionSQL({ identifier: column })} · both tables`))
            : undefined,
      });
      steps[steps.length - 1].stats = buildBizOperationStats(query, filterScopes, { kind: "join", index });
    }
    if (query.where_clause) {
      add("FILTER", expressionSQL(query.where_clause.this), scope, conditionCard(query.where_clause.this));
      steps[steps.length - 1].filter = buildBizFilterPlan(query, filterScopes);
      const conditions = getBizFilterConditions(query.where_clause.this);
      steps[steps.length - 1].filterCards = conditions.map((condition) => ({ primary: expressionSQL(condition) }));
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
        .map((projection) => {
          const metric = shortExpression(unalias(projection.expression), "Calculated metric");
          return "alias" in projection.expression ? `${metric} → ${outputCaption(projection.expression)}` : metric;
        });
      const extraMetrics = [...aggregates].filter(
        (aggregate) =>
          !projections.some(
            (projection) =>
              projection.aggregates.length &&
              !projection.windows.length &&
              assignment(projection.expression) === aggregate
          )
      );
      const captions = [...metrics, ...extraMetrics.map((metric) => shortPreview(metric, "Calculated metric"))];
      add("AGGREGATE", [grouping, ...aggregates].filter(Boolean).join(" · "), scope, {
        primary: grouping
          ? query.group_by?.all
            ? "Group by all fields"
            : `By ${columnCaption(groupingExpressions, "Calculated groups")}`
          : "All rows",
        secondary: previewLines(captions),
      });
      steps[steps.length - 1].stats = buildBizOperationStats(query, filterScopes, { kind: "aggregate" });
    }
    if (query.having) {
      add("FILTER GROUPS", `HAVING ${expressionSQL(query.having.this)}`, scope, conditionCard(query.having.this));
      steps[steps.length - 1].stats = buildBizOperationStats(query, filterScopes, { kind: "having" });
    }
    for (const projection of projections) {
      if (projection.windows.length) {
        add("WINDOW", assignment(projection.expression), scope, windowCard(projection.expression, query.windows));
      }
    }
    const displayedWindows = new Set(projections.flatMap((projection) => projection.windows.map(expressionSQL)));
    for (const clause of [query.qualify?.this, ...(query.order_by?.expressions.map((order) => order.this) ?? [])]) {
      if (clause)
        for (const window of expressionFacts(clause).windows) {
          const detail = expressionSQL(window);
          if (!displayedWindows.has(detail)) {
            add("WINDOW", detail, scope, windowCard(window, query.windows));
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
          scope,
          {
            primary: expressionSQL({ identifier: window.name }),
            secondary: previewLines(windowContext(window.spec)) ?? "All rows",
          }
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
    add("SELECT", query.expressions.map(outputProjection).join(", "), scope, {
      primary: query.expressions.some((expression) => "star" in unalias(expression))
        ? "All fields"
        : `${query.expressions.length} ${query.expressions.length === 1 ? "field" : "fields"}`,
      secondary: query.expressions.some((expression) => "star" in unalias(expression))
        ? undefined
        : previewLines(query.expressions.map(outputCaption)),
    });
    if (query.distinct || query.distinct_on) {
      add(
        "DEDUPLICATE",
        query.distinct_on
          ? `DISTINCT ON (${list(query.distinct_on)})`
          : `DISTINCT ${query.expressions.map(outputProjection).join(", ")}`,
        scope,
        {
          primary: "Unique rows",
          secondary: query.distinct_on ? columnCaption(query.distinct_on, "Selected fields") : undefined,
        }
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
  const caption = (item: (typeof order.expressions)[number]) =>
    `${columnCaption([resolve(item.this)], "Calculated value")} ${item.desc ? "↓" : "↑"}`;
  return {
    primary: first ? caption(first) : "",
    secondary:
      [
        ...order.expressions.slice(1, SQL_BIZ_PREVIEW_LIMIT).map(caption),
        ...(order.expressions.length > SQL_BIZ_PREVIEW_LIMIT
          ? [`+${order.expressions.length - SQL_BIZ_PREVIEW_LIMIT} more`]
          : []),
      ].join("\n") || undefined,
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

export function getSQLBizFilterPreviews(step: BizStep, removed?: readonly number[]) {
  const cards = step.filterCards?.length ? step.filterCards : [step.card ?? { primary: step.detail }];
  const ranked = cards.map((card, index) => ({ card, index }));
  // Every condition uses the same input denominator. Ties retain SQL order.
  if (removed?.length === cards.length) ranked.sort((a, b) => removed[b.index] - removed[a.index] || a.index - b.index);
  return ranked.slice(0, SQL_BIZ_PREVIEW_LIMIT);
}

export function getSQLBizCardWidth(step: BizStep, availableWidth = Infinity): number {
  if (step.children) return getSQLBizGroupLayout(step, availableWidth).w;
  const cards = [step.card ?? { primary: step.detail }, ...(step.filterCards ?? [])];
  // Match the monospace card text, leaving room for padding and borders.
  const primaryWidth =
    Math.max(...cards.flatMap((card) => card.primary.split("\n").map((line) => Array.from(line).length))) * 7.3;
  const secondaryWidth =
    Math.max(0, ...cards.flatMap((card) => (card.secondary ?? "").split("\n").map((line) => Array.from(line).length))) *
    7.3;
  const width = Math.ceil(
    Math.max(step.filter || step.stats ? 260 : 132, primaryWidth + (step.filter ? 144 : 28), secondaryWidth + 28)
  );
  return Math.min(width, Math.max(132, Math.min(360, availableWidth)));
}

export const SQL_BIZ_CARD_GAP = 12;

export function getSQLBizCardHeight(step: BizStep, availableWidth = Infinity): number {
  if (step.children) return getSQLBizGroupLayout(step, availableWidth).h;
  const cards = [step.card ?? { primary: step.detail }, ...(step.filterCards ?? [])];
  const width = getSQLBizCardWidth(step, availableWidth);
  const lines = (text: string, charWidth: number, padding: number) =>
    text
      .split("\n")
      .reduce(
        (sum, line) =>
          sum + Math.max(1, Math.ceil((Array.from(line).length * charWidth) / Math.max(1, width - padding))),
        0
      );
  const textHeight = (card: BizCard) =>
    lines(card.primary, 7.3, step.filter ? 144 : 28) * 16.8 +
    (card.secondary ? 6 + lines(card.secondary, 7.3, 28) * 16.8 : 0);
  if (step.filter || step.filterCards?.length) {
    const previews = step.filterCards?.length ? step.filterCards : cards;
    const previewHeight = previews
      .map(textHeight)
      .sort((a, b) => b - a)
      .slice(0, SQL_BIZ_PREVIEW_LIMIT)
      .reduce((sum, height) => sum + height + (step.filter ? 0 : 6), 0);
    return (
      52 +
      previewHeight +
      (previews.length > SQL_BIZ_PREVIEW_LIMIT ? 20 : 0) +
      (step.filter ? 26 : 0) +
      (step.scope ? 18 : 0)
    );
  }
  const statsKind = step.stats && "kind" in step.stats ? step.stats.kind : undefined;
  const statsHeight =
    statsKind === "buckets"
      ? 142
      : statsKind === "join" || statsKind === "limit" || statsKind === "skip"
        ? 64
        : statsKind === "clean"
          ? 88
          : statsKind === "combine"
            ? 112
            : statsKind === "aggregate"
              ? 192
              : step.stats
                ? 40
                : 0;
  return Math.max(82, ...cards.map((card) => 52 + textHeight(card) + statsHeight + (step.scope ? 18 : 0)));
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
