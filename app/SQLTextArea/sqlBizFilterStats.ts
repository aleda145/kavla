import { ast, Dialect, generate, parse } from "@polyglot-sql/sdk";

export type BizFilterPlan = { error: string } | { totalSQL: string; conditionsSQL: string; conditions: string[] };

function sql(expression: ast.Expression): string {
  const result = generate([expression], Dialect.DuckDB);
  if (!result.success || !result.sql?.[0] || result.sql[0].includes("/* unsupported expression */")) {
    throw new Error(result.error ?? "Could not generate filter counts SQL.");
  }
  return result.sql[0];
}

// Split only top-level ANDs. OR groups, NOT and BETWEEN remain single conditions.
function conditions(expression: ast.Expression): ast.Expression[] {
  if ("paren" in expression) {
    const parts = conditions(expression.paren.this);
    return parts.length > 1 ? parts : [expression];
  }
  if ("and" in expression) return [...conditions(expression.and.left), ...conditions(expression.and.right)];
  return [expression];
}

export function buildBizFilterPlan(
  query: ast.ExpressionInner<"select">,
  scopes: ast.ExpressionInner<"with">[]
): BizFilterPlan {
  try {
    if (!query.where_clause) throw new Error("This query no longer contains a filter.");
    if (scopes.some((scope) => scope.recursive)) {
      throw new Error("Row counts inside a recursive CTE are not supported yet.");
    }
    if (query.connect || query.into || query.locks.length) {
      throw new Error("Filter counts are not supported for this query's hierarchy, INTO or locking clauses.");
    }
    const predicate = query.where_clause.this;
    const aliases = new Set(
      query.expressions.flatMap((item) => ("alias" in item ? [item.alias.alias.name.toLowerCase()] : []))
    );
    if (
      ast
        .getColumns(predicate)
        .some((item) => "column" in item && !item.column.table && aliases.has(item.column.name.name.toLowerCase()))
    ) {
      throw new Error(
        "Filter counts are not supported yet when a condition refers to a SELECT alias. Use the source column or expression instead."
      );
    }
    const parts = conditions(predicate);
    const build = (includeConditions: boolean) => {
      const predicates = [predicate, ...(includeConditions ? parts : [])];
      // COUNT(CASE ...) treats both FALSE and NULL as removed, just like WHERE.
      const projections = parse(
        `SELECT COUNT(*) AS input_rows, ${predicates
          .map(
            (part, index) => `COUNT(CASE WHEN (${sql(part)}) THEN 1 END) AS kept_${index},
            COUNT(CASE WHEN (${sql(part)}) IS NULL THEN 1 END) AS null_${index}`
          )
          .join(", ")}`,
        Dialect.DuckDB
      );
      const root = projections.ast?.[0];
      if (!projections.success || !root || !("select" in root)) {
        throw new Error(projections.error ?? "Could not build filter counts.");
      }
      // Start with a plain aggregate SELECT: later projection, grouping, sorting,
      // DISTINCT and row limits must not affect the rows entering this filter.
      let result = sql({
        select: {
          ...root.select,
          from: query.from,
          joins: query.joins,
          lateral_views: query.lateral_views,
          prewhere: query.prewhere,
          sample: query.sample,
          with: query.with,
        },
      });
      // Nested WITH scopes preserve shadowing and the preceding CTEs visible here.
      for (const scope of [...scopes].reverse()) {
        if (!scope.ctes.length) continue;
        const wrapper = parse(`SELECT * FROM (${result}) AS kavla_filter_scope`, Dialect.DuckDB);
        const root = wrapper.ast?.[0];
        if (!wrapper.success || !root || !("select" in root)) {
          throw new Error(wrapper.error ?? "Could not resolve the filter's CTE scope.");
        }
        result = sql({ select: { ...root.select, with: scope } });
      }
      return result.trim().replace(/"\{([A-Za-z_][A-Za-z0-9_]*)\}"/g, "{$1}");
    };
    return {
      totalSQL: build(false),
      conditionsSQL: build(true),
      conditions: parts.map((part) => sql(part).replace(/"\{([A-Za-z_][A-Za-z0-9_]*)\}"/g, "{$1}")),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export type BizFilterCounts = {
  input: number;
  removed: number;
  conditions: number[];
  nulls?: number;
  conditionNulls: (number | undefined)[];
};

export function readBizFilterCounts(row: Record<string, unknown>, conditionCount: number): BizFilterCounts {
  const count = (name: string) => {
    const raw = row[name];
    if (typeof raw !== "number" && typeof raw !== "bigint" && typeof raw !== "string") {
      throw new Error(`Missing filter count: ${name}.`);
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid filter count: ${name}.`);
    return value;
  };
  const input = count("input_rows");
  const removed = (name: string) => {
    const kept = count(name);
    if (kept > input) throw new Error("The filter count exceeds the number of input rows.");
    return input - kept;
  };
  const nulls = (index: number) => {
    // Older saved analysis can still supply the original counts.
    if (!Object.hasOwn(row, `null_${index}`)) return undefined;
    const value = count(`null_${index}`);
    if (value > removed(`kept_${index}`)) throw new Error("NULL filter counts exceed removed rows.");
    return value;
  };
  return {
    input,
    removed: removed("kept_0"),
    conditions: Array.from({ length: conditionCount }, (_, index) => removed(`kept_${index + 1}`)),
    nulls: nulls(0),
    conditionNulls: Array.from({ length: conditionCount }, (_, index) => nulls(index + 1)),
  };
}

export function formatBizPercentage(rows: number, input: number): string {
  const percent = input ? (100 * rows) / input : 0;
  const displayed = rows < input ? Math.min(percent, 99.9) : percent;
  return `${displayed.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

export function formatBizFilterCount(removed: number, input: number): string {
  return `${removed.toLocaleString()} ${removed === 1 ? "row" : "rows"} removed · ${formatBizPercentage(removed, input)}`;
}
