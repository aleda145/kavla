import { ast, Dialect, generate, parse } from "@polyglot-sql/sdk";
import { quoteIdentifier } from "../src/duckdb/sql";

type Select = ast.ExpressionInner<"select">;
type Scope = ast.ExpressionInner<"with">;
type Operation =
  "join" | "aggregate" | "deduplicate" | "buckets" | "clean" | "having" | "qualify" | "limit" | "skip" | "combine";
export type BizOperationStatsPlan =
  | { error: string }
  | { kind: Exclude<Operation, "combine">; sql: string; aggregateNulls?: string[] }
  | { kind: "combine"; sql: string; operation: "UNION" | "INTERSECT" | "EXCEPT"; all: boolean };
type StatsTarget =
  | { kind: "join"; index: number }
  | { kind: "aggregate" }
  | { kind: "deduplicate" }
  | { kind: "having" }
  | { kind: "qualify" }
  | { kind: "limit" }
  | { kind: "skip" }
  | { kind: "clean"; expression: ast.Expression; beforeAggregation: boolean }
  | { kind: "buckets"; expression: ast.Expression; beforeAggregation: boolean };

export const bizCleaningFunctions = new Set([
  "lower",
  "upper",
  "trim",
  "ltrim",
  "rtrim",
  "replace",
  "regexp_replace",
  "regex_replace",
  "coalesce",
  "nullif",
  "null_if",
  "ifnull",
  "if_null",
  "nvl",
  "normalize",
  "strip_accents",
  "try_cast",
]);

function render(expression: ast.Expression): string {
  const result = generate([expression], Dialect.DuckDB);
  if (!result.success || !result.sql?.[0] || result.sql[0].includes("/* unsupported expression */")) {
    throw new Error(result.error ?? "Could not generate operation statistics SQL.");
  }
  return result.sql[0];
}

function select(sql: string): Select {
  const result = parse(sql, Dialect.DuckDB);
  const root = result.ast?.[0];
  if (!result.success || !root || !("select" in root)) throw new Error(result.error ?? "Expected a SELECT query.");
  return root.select;
}

function input(query: Select, projection: string, filtered = true): Select {
  return {
    ...select(`SELECT ${projection}`),
    from: query.from,
    joins: query.joins,
    lateral_views: query.lateral_views,
    prewhere: query.prewhere,
    sample: query.sample,
    where_clause: filtered ? query.where_clause : null,
  };
}

function withoutLimits(query: Select): Select {
  return {
    ...query,
    with: null,
    order_by: null,
    sort_by: null,
    limit: null,
    offset: null,
    fetch: null,
    top: null,
    limit_by: null,
  };
}

function inScope(sql: string, query: Pick<Select, "with">, scopes: Scope[]): string {
  for (const scope of [...scopes, ...(query.with ? [query.with] : [])].reverse()) {
    if (!scope.ctes.length) continue;
    const wrapper = select(`SELECT * FROM (${sql}) AS kavla_operation_scope`);
    sql = render({ select: { ...wrapper, with: scope } });
  }
  return sql.replace(/"\{([A-Za-z_][A-Za-z0-9_]*)\}"/g, "{$1}");
}

function assertInputFilter(query: Select) {
  if (!query.where_clause) return;
  const aliases = new Set(
    query.expressions.flatMap((item) => ("alias" in item ? [item.alias.alias.name.toLowerCase()] : []))
  );
  if (
    ast
      .getColumns(query.where_clause.this)
      .some((item) => "column" in item && !item.column.table && aliases.has(item.column.name.name.toLowerCase()))
  )
    throw new Error("These statistics do not yet support WHERE conditions referring to SELECT aliases.");
}

function cleaningInput(expression: ast.Expression): ast.Expression {
  const firstInput = (node: ast.Expression): ast.Expression | undefined => {
    if ("paren" in node) return firstInput(node.paren.this);
    if ("lower" in node) return node.lower.this;
    if ("upper" in node) return node.upper.this;
    if ("trim" in node) return node.trim.this;
    if ("try_cast" in node) return node.try_cast.this;
    if ("coalesce" in node) return node.coalesce.expressions[0];
    if ("function" in node && bizCleaningFunctions.has(node.function.name.toLowerCase())) return node.function.args[0];
    return undefined;
  };
  let original = firstInput(expression);
  if (!original) throw new Error("Cannot determine the value before cleaning for this combined expression.");
  for (let next = firstInput(original); next; next = firstInput(original)) original = next;
  return original;
}

function cleanSQL(query: Select, expression: ast.Expression, beforeAggregation: boolean): string {
  const cleaned = "alias" in expression ? expression.alias.this : expression;
  const original = cleaningInput(cleaned);
  let values: Select;
  let beforeName = "kavla_before_clean",
    afterName = "kavla_after_clean";
  if (beforeAggregation) {
    assertInputFilter(query);
    values = input(query, `${render(original)} AS ${beforeName}, ${render(cleaned)} AS ${afterName}`);
  } else {
    if (query.expressions.some((item) => "star" in item)) {
      throw new Error("Cleaning statistics after aggregation or windows require explicit output columns.");
    }
    const names = new Set(
      query.expressions.flatMap((item) =>
        "alias" in item
          ? [item.alias.alias.name.toLowerCase()]
          : "column" in item
            ? [item.column.name.name.toLowerCase()]
            : []
      )
    );
    while (names.has(beforeName)) beforeName += "_";
    while (names.has(afterName)) afterName += "_";
    values = {
      ...withoutLimits(query),
      distinct: false,
      distinct_on: null,
      qualify: null,
      expressions: [
        ...query.expressions,
        ...select(`SELECT ${render(original)} AS ${beforeName}, ${render(cleaned)} AS ${afterName}`).expressions,
      ],
    };
  }
  // Compare representations so TRY_CAST can be measured without casting invalid
  // source strings back to the output type. NULL changes count; NULL → NULL does not.
  return `SELECT COUNT(*) AS input_rows,
    COUNT(CASE WHEN CAST(${beforeName} AS VARCHAR) IS DISTINCT FROM CAST(${afterName} AS VARCHAR) THEN 1 END) AS changed_rows,
    COUNT(CASE WHEN ${beforeName} IS NULL AND ${afterName} IS NOT NULL THEN 1 END) AS null_replaced,
    COUNT(CASE WHEN ${beforeName} IS NOT NULL AND ${afterName} IS NULL THEN 1 END) AS null_created
    FROM (${render({ select: values })}) cleaned_values`;
}

function countsSQL(before: Select, after: Select): string {
  return `SELECT (SELECT COUNT(*) FROM (${render({ select: before })}) before_operation) AS input_rows,
    (SELECT COUNT(*) FROM (${render({ select: after })}) after_operation) AS output_rows`;
}

function aggregateNullInputs(query: Select): { label: string; value: ast.Expression; filter: ast.Expression | null }[] {
  const metrics = new Map<string, { label: string; value: ast.Expression; filter: ast.Expression | null }>();
  const aliases = new Set(
    query.expressions.flatMap((item) => {
      if (!("alias" in item)) return [];
      const name = item.alias.alias.name.toLowerCase();
      const value = item.alias.this;
      // An aggregate cannot read another aggregate alias. In SUM(x) AS x,
      // the inner x therefore still refers to the source column.
      if (ast.getAggregateFunctions(value).length) return [];
      if ("column" in value && value.column.name.name.toLowerCase() === name) return [];
      return [name];
    })
  );
  let nested = 0;
  for (const expression of [...query.expressions, ...(query.having ? [query.having.this] : [])]) {
    ast.walk(expression, {
      enter(node) {
        if ("select" in node || "window_function" in node) nested++;
        if (nested) return;
        const aggregate =
          "sum" in node
            ? node.sum
            : "avg" in node
              ? node.avg
              : "min" in node
                ? node.min
                : "max" in node
                  ? node.max
                  : "count" in node && !node.count.star
                    ? node.count
                    : null;
        if (!aggregate?.this) return;
        // Without an input schema, SELECT aliases cannot be rebound reliably.
        // Keep the existing row counts when an individual NULL metric is unavailable.
        if (
          ast
            .getColumns(node)
            .some((item) => "column" in item && !item.column.table && aliases.has(item.column.name.name.toLowerCase()))
        )
          return;
        if (ast.findAll(node, (item) => "select" in item || "window_function" in item).length) return;
        const label = render(node).replace(/"\{([A-Za-z_][A-Za-z0-9_]*)\}"/g, "{$1}");
        metrics.set(label, { label, value: aggregate.this, filter: aggregate.filter });
      },
      leave(node) {
        if ("select" in node || "window_function" in node) nested--;
      },
    });
  }
  return [...metrics.values()];
}

function joinSQL(query: Select, index: number): string {
  const join = query.joins[index];
  if (
    !join ||
    ![
      "Inner",
      "Left",
      "Right",
      "Full",
      "Outer",
      "Cross",
      "Semi",
      "Anti",
      "LeftSemi",
      "LeftAnti",
      "RightSemi",
      "RightAnti",
      "Implicit",
    ].includes(join.kind) ||
    join.match_condition ||
    join.pivots?.length
  ) {
    throw new Error(
      "Match statistics currently support ordinary ON, USING and CROSS joins; this join uses different matching rules."
    );
  }
  let left = { ...input(query, "1", false), joins: query.joins.slice(0, index) };
  let right: Select = { ...select("SELECT 1"), from: { expressions: [join.this] } };
  let condition = join.on ? render(join.on) : "TRUE";
  if (join.using.length) {
    const keys = join.using.map((key) => render({ identifier: key })).join(", ");
    // A chained USING join exposes merged keys. Keep those semantics when naming
    // the two inputs for the correlated existence checks.
    left.expressions = select(`SELECT ${keys}`).expressions;
    right.expressions = select(`SELECT ${keys}`).expressions;
    left = select(`SELECT 1 FROM (${render({ select: left })}) AS kavla_join_left`);
    right = select(`SELECT 1 FROM (${render({ select: right })}) AS kavla_join_right`);
    condition = join.using
      .map((key) => {
        const name = render({ identifier: key });
        return `kavla_join_left.${name} = kavla_join_right.${name}`;
      })
      .join(" AND ");
  }
  const predicate = select(`SELECT 1 WHERE ${condition}`).where_clause;
  const leftExists = render({ select: { ...left, where_clause: predicate } });
  const rightExists = render({ select: { ...right, where_clause: predicate } });
  const countMatches = (source: Select, other: string) =>
    render({
      select: {
        ...source,
        expressions: select(
          `SELECT COUNT(*) AS input_rows, COUNT(CASE WHEN EXISTS (${other}) THEN 1 END) AS matched_rows`
        ).expressions,
      },
    });
  // EXISTS counts each input row once, even if duplicate keys multiply output rows.
  return `SELECT l.input_rows AS left_rows, l.matched_rows AS left_matched,
    r.input_rows AS right_rows, r.matched_rows AS right_matched
    FROM (${countMatches(left, rightExists)}) l
    CROSS JOIN (${countMatches(right, leftExists)}) r`;
}

export function buildBizOperationStats(query: Select, scopes: Scope[], target: StatsTarget): BizOperationStatsPlan {
  try {
    if (scopes.some((scope) => scope.recursive))
      throw new Error("Statistics inside a recursive CTE are not supported yet.");
    if (query.connect || query.into || query.locks.length)
      throw new Error("Statistics are not supported for this query's hierarchy, INTO or locking clauses.");
    if (
      query.sample ||
      ast.findAll({ select: query }, (node) => "table" in node && Boolean(node.table.table_sample)).length
    ) {
      throw new Error("Statistics for sampled inputs are not supported yet because samples can change between counts.");
    }
    let sql: string;
    let aggregateNulls: string[] | undefined;
    if (target.kind === "join") {
      sql = joinSQL(query, target.index);
    } else if (target.kind === "clean") {
      sql = cleanSQL(query, target.expression, target.beforeAggregation);
    } else if (target.kind === "having" || target.kind === "qualify") {
      const clause = target.kind === "having" ? query.having : query.qualify;
      if (!clause) throw new Error("This query no longer contains that filter.");
      if (
        query.expressions.some(
          (expression) =>
            ast.findAll(
              expression,
              (node) => "unnest" in node || ("function" in node && node.function.name.toLowerCase() === "unnest")
            ).length
        )
      )
        throw new Error("Filter counts with row-expanding SELECT expressions are not supported yet.");
      const after = { ...withoutLimits(query), order_by: query.order_by, distinct: false, distinct_on: null };
      if (target.kind === "having") after.qualify = null;
      // Keep the predicate bound so aggregates/windows appearing only in the
      // clause still define the input stage, while allowing every row through.
      const alwaysTrue = select(`SELECT 1 WHERE (${render(clause.this)}) OR TRUE`).where_clause!.this;
      const before =
        target.kind === "having"
          ? { ...after, having: { ...query.having!, this: alwaysTrue } }
          : { ...after, qualify: { ...query.qualify!, this: alwaysTrue } };
      sql = countsSQL(before, after);
    } else if (target.kind === "limit" || target.kind === "skip") {
      if (query.limit_by?.length) throw new Error("Per-group LIMIT BY statistics are not supported yet.");
      const unlimited = { ...withoutLimits(query), order_by: query.order_by, sort_by: query.sort_by };
      const before = target.kind === "skip" ? unlimited : { ...unlimited, offset: query.offset };
      const after = target.kind === "skip" ? { ...unlimited, offset: query.offset } : { ...query, with: null };
      sql = countsSQL(before, after);
    } else if (target.kind === "aggregate" || target.kind === "deduplicate") {
      let before: Select;
      let after: Select;
      if (target.kind === "aggregate") {
        assertInputFilter(query);
        if (
          query.expressions.some(
            (expression) =>
              ast.findAll(
                expression,
                (node) => "unnest" in node || ("function" in node && node.function.name.toLowerCase() === "unnest")
              ).length
          )
        ) {
          throw new Error("Aggregate counts with row-expanding SELECT expressions are not supported yet.");
        }
        before = input(query, "1");
        after = query.group_by
          ? { ...withoutLimits(query), having: null, qualify: null, distinct: false, distinct_on: null }
          : input(query, "COUNT(*)");
      } else {
        after = withoutLimits(query);
        before = { ...after, distinct: false, distinct_on: null };
      }
      sql = countsSQL(before, after);
      if (target.kind === "aggregate") {
        const metrics = aggregateNullInputs(query);
        if (metrics.length) {
          aggregateNulls = metrics.map((metric) => metric.label);
          const projections = metrics.flatMap((metric, index) => {
            const predicate = metric.filter ? `(${render(metric.filter)})` : "TRUE";
            return [
              `COUNT(CASE WHEN ${predicate} THEN 1 END) AS null_input_${index}`,
              `COUNT(CASE WHEN ${predicate} AND (${render(metric.value)}) IS NULL THEN 1 END) AS null_${index}`,
            ];
          });
          const measured = input(query, ["COUNT(*) AS input_rows", ...projections].join(", "));
          sql = `SELECT aggregate_input.*, (SELECT COUNT(*) FROM (${render({ select: after })}) after_operation) AS output_rows
            FROM (${render({ select: measured })}) aggregate_input`;
        }
      }
    } else {
      const expression = "alias" in target.expression ? target.expression.alias.this : target.expression;
      let rows: string;
      if (target.beforeAggregation) {
        assertInputFilter(query);
        rows = render({ select: input(query, `${render(expression)} AS bucket_value`) });
      } else {
        if (!("alias" in target.expression))
          throw new Error("Add an alias to this expression to inspect its resulting buckets.");
        const projected = { ...withoutLimits(query), distinct: false, distinct_on: null, qualify: null };
        rows = `SELECT ${quoteIdentifier(target.expression.alias.alias.name)} AS bucket_value FROM (${render({ select: projected })}) projected_buckets`;
      }
      // Return all bucket counts in the denominator, but bound the popup to the
      // eight largest buckets plus the remaining distribution combined as Other.
      // Rank non-NULL buckets first so NULL always has its own row outside Other.
      // SUM widens BIGINT counts to HUGEINT. Keep Arrow values as Int64 rather
      // than Decimal128 so live and published statistics retain exact integers.
      sql = `WITH kavla_bucket_counts AS (
        SELECT bucket_value, COUNT(*) AS bucket_rows FROM (${rows}) bucket_input GROUP BY bucket_value
      ), kavla_bucket_ranked AS (
        SELECT *, ROW_NUMBER() OVER (ORDER BY bucket_value IS NULL, bucket_rows DESC, CAST(bucket_value AS VARCHAR) ASC NULLS LAST) AS bucket_rank,
          CAST(SUM(bucket_rows) OVER () AS BIGINT) AS input_rows, COUNT(*) OVER () AS bucket_count FROM kavla_bucket_counts
      )
      SELECT CAST(bucket_value AS VARCHAR) AS bucket_value, bucket_value IS NULL AS bucket_null,
        bucket_rows, input_rows, bucket_count, FALSE AS other FROM kavla_bucket_ranked WHERE bucket_rank <= 8 OR bucket_value IS NULL
      UNION ALL
      SELECT NULL, FALSE, CAST(SUM(bucket_rows) AS BIGINT), MAX(input_rows), MAX(bucket_count), TRUE
        FROM kavla_bucket_ranked WHERE bucket_rank > 8 AND bucket_value IS NOT NULL HAVING COUNT(*) > 0
      ORDER BY other, bucket_null, bucket_rows DESC, bucket_value`;
    }
    return { kind: target.kind, sql: inScope(sql, query, scopes), ...(aggregateNulls ? { aggregateNulls } : {}) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function buildBizCombineStats(
  expression: ast.Expression,
  scopes: Scope[],
  context: ast.Expression = expression
): BizOperationStatsPlan {
  try {
    // Polyglot currently parses unparenthesized mixed set operations left to
    // right, while SQL gives INTERSECT higher precedence. Do not count stages
    // inferred from that ambiguous tree (including its apparent child stages).
    if (
      ast.findAll(
        context,
        (node) => "intersect" in node && ("union" in node.intersect.left || "except" in node.intersect.left)
      ).length
    ) {
      throw new Error(
        "Add parentheses around mixed INTERSECT and UNION/EXCEPT operations so each input can be measured accurately."
      );
    }
    const combined = structuredClone(expression);
    const operation = "union" in combined ? "UNION" : "intersect" in combined ? "INTERSECT" : "EXCEPT";
    const query =
      "union" in combined
        ? combined.union
        : "intersect" in combined
          ? combined.intersect
          : "except" in combined
            ? combined.except
            : null;
    if (!query) throw new Error("Cannot identify the inputs to this combine operation.");
    if (scopes.some((scope) => scope.recursive))
      throw new Error("Statistics inside a recursive CTE are not supported yet.");
    if (
      ast.findAll(
        expression,
        (node) =>
          ("select" in node && Boolean(node.select.sample)) || ("table" in node && Boolean(node.table.table_sample))
      ).length
    ) {
      throw new Error("Statistics for sampled inputs are not supported yet because samples can change between counts.");
    }
    const withClause = query.with;
    query.with = null;
    query.order_by = null;
    query.limit = null;
    query.offset = null;
    // A trailing FETCH belongs to the combined output. Parenthesized branches
    // retain their own ORDER BY, LIMIT, OFFSET and FETCH when counted as inputs.
    if ("select" in query.right) query.right.select.fetch = null;
    const sql = `SELECT
      (SELECT COUNT(*) FROM (${render(query.left)}) combine_left) AS left_rows,
      (SELECT COUNT(*) FROM (${render(query.right)}) combine_right) AS right_rows,
      (SELECT COUNT(*) FROM (${render(combined)}) combine_output) AS output_rows`;
    return { kind: "combine", operation, all: query.all, sql: inScope(sql, { with: withClause }, scopes) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function buildBizRowLimitStats(
  expression: ast.Expression,
  scopes: Scope[],
  kind: "limit" | "skip"
): BizOperationStatsPlan {
  if ("select" in expression) return buildBizOperationStats(expression.select, scopes, { kind });
  try {
    if ("subquery" in expression) {
      const nested = expression.subquery;
      const wrapper = select(`SELECT * FROM (${render(nested.this)}) AS kavla_limit_input`);
      return buildBizOperationStats(
        {
          ...wrapper,
          order_by: nested.order_by,
          offset: nested.offset,
          limit: nested.limit,
        },
        scopes,
        { kind }
      );
    }
    if (scopes.some((scope) => scope.recursive))
      throw new Error("Statistics inside a recursive CTE are not supported yet.");
    const before = structuredClone(expression);
    const after = structuredClone(expression);
    const clause = (node: ast.Expression) => {
      if ("union" in node) return node.union;
      if ("intersect" in node) return node.intersect;
      if ("except" in node) return node.except;
      throw new Error("Cannot identify the input to this row limit.");
    };
    const beforeClause = clause(before),
      afterClause = clause(after);
    beforeClause.limit = null;
    if (kind === "skip") {
      beforeClause.offset = null;
      afterClause.limit = null;
    }
    // Polyglot stores a combined query's trailing FETCH on its right SELECT.
    if ("right" in beforeClause && "select" in beforeClause.right) beforeClause.right.select.fetch = null;
    if (kind === "skip" && "right" in afterClause && "select" in afterClause.right)
      afterClause.right.select.fetch = null;
    const sql = `SELECT (SELECT COUNT(*) FROM (${render(before)}) before_operation) AS input_rows,
      (SELECT COUNT(*) FROM (${render(after)}) after_operation) AS output_rows`;
    return { kind, sql: inScope(sql, { with: null }, scopes) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export type BizOperationStats =
  | { kind: "join"; left: number; leftMatched: number; right: number; rightMatched: number }
  | { kind: "combine"; left: number; right: number; output: number }
  | { kind: "aggregate"; input: number; output: number; nulls: { label: string; input: number; skipped: number }[] }
  | { kind: "deduplicate" | "having" | "qualify" | "limit" | "skip"; input: number; output: number }
  | { kind: "clean"; input: number; changed: number; nullReplaced?: number; nullCreated?: number }
  | {
      kind: "buckets";
      input: number;
      count: number;
      buckets: { label: string; rows: number; other: boolean; isNull: boolean }[];
    };

export function readBizOperationStats(
  kind: Operation,
  rows: Record<string, unknown>[],
  aggregateNulls: readonly string[] = []
): BizOperationStats {
  const count = (row: Record<string, unknown>, field: string) => {
    const raw = row[field];
    if (typeof raw !== "number" && typeof raw !== "bigint" && typeof raw !== "string")
      throw new Error(`Missing statistic: ${field}.`);
    const result = Number(raw);
    if (!Number.isSafeInteger(result) || result < 0) throw new Error(`Invalid statistic: ${field}.`);
    return result;
  };
  if (kind === "buckets") {
    if (!rows.length) return { kind, input: 0, count: 0, buckets: [] };
    const input = count(rows[0], "input_rows");
    const buckets = rows.map((row) => ({
      label: row.other === true ? "Other" : row.bucket_null === true ? "NULL" : String(row.bucket_value),
      rows: count(row, "bucket_rows"),
      other: row.other === true,
      isNull: row.bucket_null === true,
    }));
    if (buckets.reduce((sum, bucket) => sum + bucket.rows, 0) !== input)
      throw new Error("Bucket counts do not add up to the input rows.");
    return { kind, input, count: count(rows[0], "bucket_count"), buckets };
  }
  if (rows.length !== 1) throw new Error("Expected one row of operation statistics.");
  const row = rows[0];
  if (kind === "join") {
    const left = count(row, "left_rows"),
      right = count(row, "right_rows");
    const leftMatched = count(row, "left_matched"),
      rightMatched = count(row, "right_matched");
    if (leftMatched > left || rightMatched > right) throw new Error("Matched rows exceed the input rows.");
    return { kind, left, right, leftMatched, rightMatched };
  }
  if (kind === "combine") {
    const left = count(row, "left_rows"),
      right = count(row, "right_rows"),
      output = count(row, "output_rows");
    if (!Number.isSafeInteger(left + right))
      throw new Error("Combined input row count is too large to display accurately.");
    if (output > left + right) throw new Error("Combined output rows exceed the input rows.");
    return { kind, left, right, output };
  }
  const inputRows = count(row, "input_rows");
  if (kind === "clean") {
    const changed = count(row, "changed_rows");
    if (changed > inputRows) throw new Error("Changed values exceed the input rows.");
    const nullReplaced = Object.hasOwn(row, "null_replaced") ? count(row, "null_replaced") : undefined;
    const nullCreated = Object.hasOwn(row, "null_created") ? count(row, "null_created") : undefined;
    if ((nullReplaced ?? 0) + (nullCreated ?? 0) > changed) throw new Error("NULL changes exceed the changed values.");
    return { kind, input: inputRows, changed, nullReplaced, nullCreated };
  }
  const output = count(row, "output_rows");
  if (kind === "aggregate") {
    const nulls = aggregateNulls.flatMap((label, index) => {
      if (!Object.hasOwn(row, `null_${index}`)) return [];
      const input = count(row, `null_input_${index}`);
      const skipped = count(row, `null_${index}`);
      if (input > inputRows || skipped > input) throw new Error("NULL aggregate counts exceed the input rows.");
      return [{ label, input, skipped }];
    });
    return { kind, input: inputRows, output, nulls };
  }
  if (output > inputRows) throw new Error("Retained rows exceed the input rows.");
  return { kind, input: inputRows, output };
}
