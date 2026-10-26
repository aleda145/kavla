import { ast, Dialect, generate, parse } from "@polyglot-sql/sdk";
import { quoteIdentifier } from "../src/duckdb/sql";

type Select = ast.ExpressionInner<"select">;
type Scope = ast.ExpressionInner<"with">;
type Operation = "join" | "aggregate" | "deduplicate" | "buckets";
export type BizOperationStatsPlan = { error: string } | { kind: Operation; sql: string };
type StatsTarget =
  | { kind: "join"; index: number }
  | { kind: "aggregate" }
  | { kind: "deduplicate" }
  | { kind: "buckets"; expression: ast.Expression; beforeAggregation: boolean };

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

function inScope(sql: string, query: Select, scopes: Scope[]): string {
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
  const output = render({
    select: { ...input(query, "COUNT(*) AS output_rows", false), joins: query.joins.slice(0, index + 1) },
  });
  // EXISTS counts each input row once, even if duplicate keys multiply output rows.
  return `SELECT l.input_rows AS left_rows, l.matched_rows AS left_matched,
    r.input_rows AS right_rows, r.matched_rows AS right_matched, o.output_rows
    FROM (${countMatches(left, rightExists)}) l
    CROSS JOIN (${countMatches(right, leftExists)}) r
    CROSS JOIN (${output}) o`;
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
    if (target.kind === "join") {
      sql = joinSQL(query, target.index);
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
      sql = `SELECT (SELECT COUNT(*) FROM (${render({ select: before })}) before_operation) AS input_rows,
        (SELECT COUNT(*) FROM (${render({ select: after })}) after_operation) AS output_rows`;
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
      sql = `WITH kavla_bucket_counts AS (
        SELECT bucket_value, COUNT(*) AS bucket_rows FROM (${rows}) bucket_input GROUP BY bucket_value
      ), kavla_bucket_ranked AS (
        SELECT *, ROW_NUMBER() OVER (ORDER BY bucket_rows DESC, CAST(bucket_value AS VARCHAR) ASC NULLS LAST) AS bucket_rank,
          SUM(bucket_rows) OVER () AS input_rows, COUNT(*) OVER () AS bucket_count FROM kavla_bucket_counts
      )
      SELECT CAST(bucket_value AS VARCHAR) AS bucket_value, bucket_value IS NULL AS bucket_null,
        bucket_rows, input_rows, bucket_count, FALSE AS other FROM kavla_bucket_ranked WHERE bucket_rank <= 8
      UNION ALL
      SELECT NULL, FALSE, SUM(bucket_rows), MAX(input_rows), MAX(bucket_count), TRUE
        FROM kavla_bucket_ranked WHERE bucket_rank > 8 HAVING COUNT(*) > 0
      ORDER BY other, bucket_rows DESC, bucket_value`;
    }
    return { kind: target.kind, sql: inScope(sql, query, scopes) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export type BizOperationStats =
  | { kind: "join"; left: number; leftMatched: number; right: number; rightMatched: number; output: number }
  | { kind: "aggregate" | "deduplicate"; input: number; output: number }
  | {
      kind: "buckets";
      input: number;
      count: number;
      buckets: { label: string; rows: number; other: boolean; isNull: boolean }[];
    };

export function readBizOperationStats(kind: Operation, rows: Record<string, unknown>[]): BizOperationStats {
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
  const output = count(row, "output_rows");
  if (kind === "join") {
    const left = count(row, "left_rows"),
      right = count(row, "right_rows");
    const leftMatched = count(row, "left_matched"),
      rightMatched = count(row, "right_matched");
    if (leftMatched > left || rightMatched > right) throw new Error("Matched rows exceed the input rows.");
    return { kind, left, right, leftMatched, rightMatched, output };
  }
  const inputRows = count(row, "input_rows");
  if (kind === "deduplicate" && output > inputRows) throw new Error("Distinct rows exceed the input rows.");
  return { kind, input: inputRows, output };
}
