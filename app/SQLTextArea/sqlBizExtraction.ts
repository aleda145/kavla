import { ast, Dialect, generate, parse } from "@polyglot-sql/sdk";
import { format } from "sql-formatter";
import { mapKnobParameters } from "../Knob/knobSQL";
import { quoteIdentifier } from "../src/duckdb/sql";
import type { BizStep } from "./sqlBizSummary";

type Column = { name: string; type: string };
type Select = ast.ExpressionInner<"select">;
export type BizExtractionPlan =
  | { enabled: false; reason: string }
  | { enabled: true; needsSchema: true; direction: "upstream" | "downstream" }
  | {
      enabled: true;
      needsSchema: false;
      direction: "upstream" | "downstream";
      upstreamSQL: string;
      outputSQL: string;
      upstreamSchema: Column[] | null;
    };

// Unknown functions are deliberately excluded: splitting volatile expressions or
// user-defined functions across query boundaries can change their evaluation.
const safeNodes = new Set([
  "select",
  "table",
  "column",
  "identifier",
  "alias",
  "star",
  "literal",
  "boolean",
  "null",
  "add",
  "sub",
  "mul",
  "div",
  "mod",
  "neg",
  "paren",
  "and",
  "or",
  "not",
  "xor",
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "is_null",
  "is",
  "between",
  "in",
  "like",
  "ilike",
  "case",
  "if_func",
  "cast",
  "try_cast",
  "typeof",
  "data_type",
  "coalesce",
  "nullif",
  "floor",
  "ceil",
  "round",
  "abs",
  "lower",
  "upper",
  "trim",
  "ltrim",
  "rtrim",
  "replace",
  "length",
  "date_trunc",
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "count_if",
  "window_function",
  "row_number",
  "rank",
  "dense_rank",
  "lag",
  "lead",
  "first_value",
  "last_value",
  "nth_value",
  "ntile",
  "percent_rank",
  "cume_dist",
]);
const safeFunctions = new Set([
  "abs",
  "floor",
  "ceil",
  "ceiling",
  "round",
  "lower",
  "upper",
  "trim",
  "ltrim",
  "rtrim",
  "replace",
  "length",
  "coalesce",
  "nullif",
  "if",
  "iff",
  "date_trunc",
  "time_bucket",
  "typeof",
]);
const transformOperations = new Set(["CALCULATE", "BUCKET", "CLEAN", "CONDITIONAL"]);

function requireSafe(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

function parseSelect(sql: string): Select {
  const result = parse(sql, Dialect.DuckDB);
  requireSafe(result.success, result.error ?? "The SQL could not be parsed.");
  requireSafe(
    Array.isArray(result.ast) && result.ast.length === 1 && "select" in result.ast[0],
    "Extraction requires a single SELECT query."
  );
  return (result.ast[0] as ast.ExpressionByKey<"select">).select;
}

function sqlFor(expression: ast.Expression): string {
  const result = generate([expression], Dialect.DuckDB);
  requireSafe(
    result.success && result.sql?.[0] && !result.sql[0].includes("/* unsupported expression */"),
    result.error ?? "This SQL expression cannot be rewritten safely."
  );
  return result.sql[0];
}

function column(name: string): ast.Expression {
  return {
    column: {
      name: { name, quoted: true, trailing_comments: [] },
      table: null,
      join_mark: false,
      trailing_comments: [],
    },
  };
}

function hasValue(value: unknown) {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

function planCTEExtraction(sql: string, step: BizStep, upstreamName: string): BizExtractionPlan {
  requireSafe(!step.scope, "Extract the enclosing CTE first; nested CTEs cannot be moved independently yet.");
  const query = parseSelect(sql);
  requireSafe(query.with && !query.with.recursive, "Recursive CTEs cannot be extracted safely yet.");
  requireSafe(
    query.with.ctes.length === 1,
    "Extraction currently supports a single standalone CTE. Dependent CTE chains must stay together."
  );
  const cte = query.with.ctes[0];
  requireSafe(cte.alias.name === step.cteName, "This CTE is no longer available.");
  requireSafe(
    cte.materialized == null && !cte.columns.length && !cte.key_expressions?.length,
    "CTE materialization hints and column alias lists cannot be moved safely yet."
  );
  requireSafe("select" in cte.this, "Only SELECT CTEs can be extracted yet.");
  const body = cte.this.select;
  requireSafe(!body.with, "Extracting a CTE containing another WITH clause is not supported yet.");
  requireSafe(
    query.from?.expressions.length === 1 && !query.joins.length,
    "The CTE must be the query's single input to extract it safely."
  );
  const reference = query.from.expressions[0];
  requireSafe(
    "table" in reference &&
      !reference.table.schema &&
      !reference.table.catalog &&
      reference.table.name.name.toLowerCase() === cte.alias.name.toLowerCase(),
    "The CTE must be referenced directly by the outer query."
  );
  for (const select of [query, body]) {
    requireSafe(
      !select.joins.length &&
        !select.lateral_views.length &&
        !select.sample &&
        !select.into &&
        !select.locks.length &&
        !select.kind &&
        !hasValue(select.operation_modifiers),
      "This CTE contains query modifiers that cannot be moved safely yet."
    );
  }
  let selects = 0;
  ast.walk(
    { select: query },
    {
      enter(node) {
        const type = ast.getExprType(node);
        if (type === "select") selects++;
        requireSafe(selects <= 2, "CTEs with nested queries cannot be extracted safely yet.");
        requireSafe(
          "function" in node ? safeFunctions.has(node.function.name.toLowerCase()) : safeNodes.has(type),
          `The expression “${"function" in node ? node.function.name : type}” is not known to be safe to extract.`
        );
        if ("table" in node)
          requireSafe(
            !node.table.table_sample && !node.table.identifier_func,
            "Sampled or dynamic table references cannot be extracted safely."
          );
      },
    }
  );
  ast.walk(cte.this, {
    enter(node) {
      if ("table" in node)
        requireSafe(
          node.table.name.name.toLowerCase() !== cte.alias.name.toLowerCase(),
          "A CTE referring to its own name cannot be extracted safely."
        );
    },
  });
  // Preserve the old relation alias so qualified references such as bucketed.x keep working.
  reference.table.alias ??= structuredClone(cte.alias);
  reference.table.alias_explicit_as = true;
  reference.table.name = { name: upstreamName, quoted: true, trailing_comments: [] };
  query.with = null;
  return {
    enabled: true,
    needsSchema: false,
    direction: "upstream",
    upstreamSQL: format(sqlFor(cte.this), { language: "duckdb", keywordCase: "upper", tabWidth: 2 }),
    outputSQL: format(sqlFor({ select: query }), { language: "duckdb", keywordCase: "upper", tabWidth: 2 }),
    upstreamSchema: null,
  };
}

export function planSQLBizExtraction(
  sql: string,
  step: BizStep,
  source: { name: string; columns: Column[] | null },
  upstreamName: string,
  outputSchema: Column[] | null = null
): BizExtractionPlan {
  try {
    let hasKnobs = false;
    mapKnobParameters(sql, () => {
      hasKnobs = true;
      return "0";
    });
    requireSafe(!hasKnobs, "Queries with knob parameters cannot be extracted yet.");
    if (step.label === "CTE") return planCTEExtraction(sql, step, upstreamName);
    requireSafe(
      !step.scope,
      step.scope?.includes("CTE ")
        ? "Extract the enclosing CTE first to separate its operations."
        : "Extracting an operation inside a subquery or set operation is not supported yet."
    );
    requireSafe(
      !["READ", "SELECT", "JOIN", "COMBINE"].includes(step.label),
      step.label === "SELECT"
        ? "There is no separate operation to extract."
        : `${step.label} has dependencies that cannot yet be separated safely.`
    );
    const query = parseSelect(sql);
    const unsupported: (keyof Select)[] = [
      "with",
      "joins",
      "lateral_views",
      "prewhere",
      "distinct_on",
      "top",
      "sample",
      "windows",
      "distribute_by",
      "cluster_by",
      "sort_by",
      "limit_by",
      "settings",
      "format",
      "hint",
      "connect",
      "into",
      "locks",
      "for_xml",
      "for_json",
      "kind",
      "operation_modifiers",
      "option",
      "exclude",
    ];
    requireSafe(
      !unsupported.some((key) => hasValue(query[key])),
      "This query contains clauses that cannot yet be separated safely (such as joins, CTEs, named windows, or DISTINCT ON)."
    );
    requireSafe(query.from?.expressions.length === 1, "Extraction requires one known source table.");
    const input = query.from.expressions[0];
    requireSafe("table" in input, "Table functions and subquery sources cannot be extracted yet.");
    const table = input.table;
    requireSafe(
      !table.schema &&
        !table.catalog &&
        !table.column_aliases.length &&
        !table.when &&
        !table.only &&
        !table.final_ &&
        !table.hints.length &&
        !table.table_sample &&
        !table.system_time &&
        !table.partitions?.length &&
        !table.identifier_func &&
        !table.changes &&
        !table.version,
      "This source uses table modifiers that cannot be moved safely."
    );
    requireSafe(table.name.name.toLowerCase() === source.name.toLowerCase(), "The source table could not be resolved.");
    const qualifier = (table.alias ?? table.name).name.toLowerCase();
    let selectCount = 0;
    const windows: ast.Expression[] = [];
    const aggregateTypes = new Set(ast.getAggregateFunctions({ select: query }).map(ast.getExprType));
    let hasGroupingAggregate = false;
    ast.walk(
      { select: query },
      {
        enter(node, parent) {
          const type = ast.getExprType(node);
          if (type === "select") selectCount++;
          if ("window_function" in node) windows.push(node);
          if (
            aggregateTypes.has(type) &&
            !(parent && "window_function" in parent && parent.window_function.this === node)
          ) {
            hasGroupingAggregate = true;
          }
          requireSafe(selectCount <= 1, "Nested queries cannot be extracted yet.");
          requireSafe(
            "function" in node ? safeFunctions.has(node.function.name.toLowerCase()) : safeNodes.has(type),
            `The expression “${"function" in node ? node.function.name : type}” is not known to be safe to extract.`
          );
          if ("column" in node && node.column.table) {
            requireSafe(
              node.column.table.name.toLowerCase() === qualifier,
              "A qualified column cannot be resolved unambiguously."
            );
          }
          if ("star" in node) {
            requireSafe(
              !node.star.table || node.star.table.name.toLowerCase() === qualifier,
              "Struct wildcards cannot be expanded safely across a query boundary."
            );
            requireSafe(
              !node.star.except?.length && !node.star.replace?.length && !node.star.rename?.length,
              "Wildcard column modifiers cannot be extracted yet."
            );
          }
        },
      }
    );

    if (step.label === "SORT") {
      requireSafe(query.order_by, "This query no longer contains that sort.");
    } else if (step.label === "LIMIT") {
      requireSafe(query.limit || query.fetch, "This query no longer contains that limit.");
      requireSafe(
        !query.limit?.percent && !query.fetch?.percent && !query.fetch?.with_ties,
        "Percentage limits and WITH TIES cannot be extracted yet."
      );
    } else if (step.label === "SKIP") {
      requireSafe(query.offset, "This query no longer contains that offset.");
    } else if (step.label === "DEDUPLICATE") {
      requireSafe(query.distinct, "This query no longer contains DISTINCT.");
    } else if (step.label === "FILTER GROUPS") {
      requireSafe(query.having, "This query no longer contains HAVING.");
      requireSafe(
        !windows.length,
        "HAVING runs before window calculations; they cannot be moved ahead of this filter."
      );
    } else if (step.label === "FILTER WINDOW") {
      requireSafe(query.qualify, "This query no longer contains QUALIFY.");
    } else if (step.label === "WINDOW") {
      requireSafe(
        new Set(windows.map(sqlFor)).size === 1,
        "Multiple window calculations cannot be separated independently yet."
      );
    } else if (step.label === "AGGREGATE") {
      requireSafe(query.group_by || hasGroupingAggregate, "This query no longer contains aggregation.");
      requireSafe(!query.group_by?.all, "GROUP BY ALL cannot be separated safely yet.");
      requireSafe(
        !windows.length,
        "Aggregation feeds window calculations; their intermediate columns cannot be separated safely yet."
      );
    } else if (transformOperations.has(step.label)) {
      requireSafe(
        !query.qualify,
        "Moving this calculation before QUALIFY could evaluate it on rows that are currently filtered out."
      );
      requireSafe(
        !query.expressions.some((item) => "star" in item),
        "A wildcard projection would gain the extracted column."
      );
    }
    const afterDistinct = Boolean(query.order_by || query.limit || query.offset || query.fetch);
    const aggregateUpstream = step.label === "AGGREGATE" && Boolean(query.having || query.distinct || afterDistinct);
    const windowUpstream = step.label === "WINDOW" && Boolean(query.qualify || query.distinct || afterDistinct);
    const distinctUpstream = step.label === "DEDUPLICATE" && afterDistinct;
    if (step.label === "WINDOW" && !windowUpstream) {
      requireSafe(
        !query.group_by && !query.having && !hasGroupingAggregate,
        "This window depends on aggregation; expose the aggregated inputs in a separate query first."
      );
    }
    if (source.columns === null) {
      return {
        enabled: true,
        needsSchema: true,
        direction:
          step.label === "FILTER" ||
          transformOperations.has(step.label) ||
          distinctUpstream ||
          aggregateUpstream ||
          windowUpstream
            ? "upstream"
            : "downstream",
      };
    }
    const sourceColumns = source.columns;
    requireSafe(sourceColumns.length, "The upstream query returned no columns.");
    const inputNames = new Set(sourceColumns.map((item) => item.name.toLowerCase()));
    requireSafe(inputNames.size === sourceColumns.length, "Duplicate source column names make extraction ambiguous.");
    const aliases = new Set(
      query.expressions.flatMap((item) => ("alias" in item ? [item.alias.alias.name.toLowerCase()] : []))
    );
    const readsOnlyInput = (expression: ast.Expression) => {
      for (const item of ast.getColumns(expression)) {
        if (!("column" in item)) continue;
        const name = item.column.name.name.toLowerCase();
        requireSafe(inputNames.has(name), "This operation depends on a calculated alias or an unknown input column.");
        requireSafe(
          item.column.table || !aliases.has(name),
          "A column and a SELECT alias have the same name; extraction is ambiguous."
        );
      }
    };
    const sourceSelect = parseSelect("SELECT *");
    sourceSelect.from = structuredClone(query.from);
    const output = structuredClone(query);
    const relation = parseSelect(`SELECT * FROM ${quoteIdentifier(upstreamName)}`).from!;
    const relationTable = relation.expressions[0];
    requireSafe("table" in relationTable, "Cannot create the extracted query reference.");
    relationTable.table.alias = structuredClone(table.alias ?? table.name);
    relationTable.table.alias_explicit_as = true;
    output.from = relation;

    let upstream = sourceSelect;
    let final = output;
    let direction: "upstream" | "downstream" = "upstream";
    let upstreamSchema: Column[] | null = sourceColumns;

    if (step.label === "FILTER") {
      requireSafe(query.where_clause, "This query no longer contains that filter.");
      readsOnlyInput(query.where_clause.this);
      upstream.where_clause = structuredClone(query.where_clause);
      final.where_clause = null;
    } else if (transformOperations.has(step.label)) {
      const index = query.expressions.findIndex(
        (item) =>
          "alias" in item && `${sqlFor({ identifier: item.alias.alias })} = ${sqlFor(item.alias.this)}` === step.detail
      );
      const expression = query.expressions[index];
      requireSafe(expression && "alias" in expression, "The expression needs an explicit, unique output alias.");
      const name = expression.alias.alias.name;
      requireSafe(!inputNames.has(name.toLowerCase()), "The output alias shadows an input column.");
      requireSafe(
        query.expressions.filter(
          (item) => "alias" in item && item.alias.alias.name.toLowerCase() === name.toLowerCase()
        ).length === 1,
        "The output alias is not unique."
      );
      requireSafe(
        !ast.getAggregateFunctions(expression).length,
        "An aggregate expression must stay with its GROUP BY."
      );
      readsOnlyInput(expression.alias.this);
      // Filtering precedes projection. Keep it with an extracted calculation so
      // expressions are never newly evaluated on rows that WHERE discarded.
      if (query.where_clause) readsOnlyInput(query.where_clause.this);
      upstream.where_clause = structuredClone(query.where_clause);
      final.where_clause = null;
      if (query.group_by || hasGroupingAggregate) {
        requireSafe(
          query.group_by && !query.group_by.all,
          "This expression is evaluated after aggregation and cannot be moved upstream."
        );
        let grouped = false;
        final.group_by = {
          ...query.group_by,
          expressions: query.group_by.expressions.map((key) => {
            const byAlias =
              "column" in key && !key.column.table && key.column.name.name.toLowerCase() === name.toLowerCase();
            const byPosition =
              "literal" in key && key.literal.literal_type === "number" && Number(key.literal.value) === index + 1;
            const byExpression = sqlFor(key) === sqlFor(expression.alias.this);
            if (byAlias || byPosition || byExpression) {
              grouped = true;
              return column(name);
            }
            return key;
          }),
        };
        requireSafe(grouped, "This expression is evaluated after grouping and cannot be moved upstream safely.");
      }
      upstream.expressions.push(structuredClone(expression));
      final.expressions[index] = column(name);
      const type = outputSchema?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.type;
      upstreamSchema = type ? [...sourceColumns, { name, type }] : null;
    } else {
      direction = "downstream";
      // Preserve output column names across the new relation boundary.
      const outputs = query.expressions.flatMap((expression) => {
        if ("star" in expression)
          return sourceColumns.map((item) => ({ name: item.name, expression: column(item.name) }));
        if ("alias" in expression) return [{ name: expression.alias.alias.name, expression: expression.alias.this }];
        requireSafe(
          "column" in expression,
          "Give calculated output columns explicit aliases before extracting this operation."
        );
        return [{ name: expression.column.name.name, expression }];
      });
      requireSafe(
        new Set(outputs.map((item) => item.name.toLowerCase())).size === outputs.length,
        "Duplicate output column names make extraction ambiguous."
      );
      for (const item of outputs) {
        const reference = parseSelect(`SELECT ${sqlFor(column(item.name))}`).expressions[0];
        requireSafe(
          "column" in reference && reference.column.name.name === item.name && !reference.column.table,
          `The output name “${item.name}” cannot be preserved safely; give it a simpler alias.`
        );
      }
      // All columns belong to the single source checked above. Normalize their
      // spelling/qualification when matching expressions to projected aliases.
      const expressionKey = (expression: ast.Expression) =>
        sqlFor(
          ast.transform(expression, {
            column: (node) => ("column" in node ? column(node.column.name.name.toLowerCase()) : undefined),
          })
        );
      const projected = outputs.map((item) => ({ ...item, key: expressionKey(item.expression) }));
      const checkProjectionBeforeFilter = (predicate: ast.Expression, clause: "HAVING" | "QUALIFY") => {
        const referencedAliases = new Set(
          ast
            .getColumns(predicate)
            .flatMap((item) => ("column" in item && !item.column.table ? [item.column.name.name.toLowerCase()] : []))
        );
        projected.forEach((item, index) => {
          const expression = item.expression;
          const grouped = query.group_by?.all
            ? !ast.getAggregateFunctions(expression).length
            : query.group_by?.expressions.some(
                (key) =>
                  expressionKey(key) === item.key ||
                  ("column" in key &&
                    !key.column.table &&
                    key.column.name.name.toLowerCase() === item.name.toLowerCase()) ||
                  ("literal" in key && key.literal.literal_type === "number" && Number(key.literal.value) === index + 1)
              );
          requireSafe(
            "column" in expression ||
              "literal" in expression ||
              "null" in expression ||
              "boolean" in expression ||
              "window_function" in expression ||
              aggregateTypes.has(ast.getExprType(expression)) ||
              grouped ||
              referencedAliases.has(item.name.toLowerCase()),
            `Separating ${clause} would evaluate “${item.name}” on results that the filter currently removes. Keep that calculation after the filter.`
          );
        });
      };
      const mapOutputExpression = (expression: ast.Expression, clause: "ORDER BY" | "HAVING" | "QUALIFY") =>
        ast.transform(expression, {
          enter(node, parent) {
            if ("column" in node && !node.column.table) {
              const name = node.column.name.name.toLowerCase();
              const alias = projected.find((item) => item.name.toLowerCase() === name);
              if (alias) {
                requireSafe(
                  (clause === "ORDER BY" && !parent) || !inputNames.has(name) || alias.key === expressionKey(node),
                  `${clause} uses “${node.column.name.name}” as both an input column and an output alias; extraction is ambiguous.`
                );
                return column(alias.name);
              }
            }
            const match = projected.find((item) => item.key === expressionKey(node));
            if (match) return column(match.name);
            requireSafe(
              !("column" in node) && !("window_function" in node) && !aggregateTypes.has(ast.getExprType(node)),
              `${clause} needs an expression or column that is not exposed by the query output. Give it an output alias before extracting.`
            );
          },
        });
      const mappedOrder = query.order_by && {
        ...query.order_by,
        expressions: query.order_by.expressions.map((item) => {
          if ("literal" in item.this && item.this.literal.literal_type === "number") {
            const ordinal = Number(item.this.literal.value);
            requireSafe(
              Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= outputs.length,
              "The sort position is invalid."
            );
            return { ...item, this: column(outputs[ordinal - 1].name) };
          }
          return { ...item, this: mapOutputExpression(item.this, "ORDER BY") };
        }),
      };
      upstream = structuredClone(query);
      final = parseSelect(`SELECT * FROM ${quoteIdentifier(upstreamName)}`);
      upstreamSchema = outputSchema;
      if ((step.label === "AGGREGATE" && !aggregateUpstream) || (step.label === "WINDOW" && !windowUpstream)) {
        if (query.where_clause) readsOnlyInput(query.where_clause.this);
        upstream = sourceSelect;
        upstream.where_clause = query.where_clause;
        final = output;
        final.where_clause = null;
        upstreamSchema = sourceColumns;
      } else {
        // Split at one logical boundary, keeping every later operation together.
        // A prefix extraction leaves the selected operation in the upstream SQL;
        // a suffix extraction moves it and its dependent operations downstream.
        const stages = ["FILTER GROUPS", "FILTER WINDOW", "DEDUPLICATE", "SORT", "SKIP", "LIMIT"];
        const boundary = aggregateUpstream ? 0 : windowUpstream ? 1 : distinctUpstream ? 3 : stages.indexOf(step.label);
        requireSafe(boundary >= 0, "This operation cannot be extracted safely yet.");
        direction = aggregateUpstream || windowUpstream || distinctUpstream ? "upstream" : "downstream";
        final.expressions = outputs.map((item) => column(item.name));
        if (boundary <= 0 && query.having) {
          checkProjectionBeforeFilter(query.having.this, "HAVING");
          final.where_clause = { this: mapOutputExpression(query.having.this, "HAVING") };
          upstream.having = null;
        }
        if (boundary <= 1 && query.qualify) {
          checkProjectionBeforeFilter(query.qualify.this, "QUALIFY");
          final.where_clause = { this: mapOutputExpression(query.qualify.this, "QUALIFY") };
          upstream.qualify = null;
        }
        if (boundary <= 2) {
          final.distinct = query.distinct;
          upstream.distinct = false;
        }
        if (boundary <= 3) upstream.order_by = null;
        if (boundary <= 4) {
          final.offset = query.offset;
          upstream.offset = null;
        }
        final.limit = query.limit;
        final.fetch = query.fetch;
        upstream.limit = null;
        upstream.fetch = null;
        // DISTINCT stays after its projection/filtering and before the final
        // sort and row limits. References use the projected column names.
        // Reassert ordering at the output boundary; subquery order is not a contract.
        final.order_by = mappedOrder;
      }
    }

    const upstreamSQL = format(sqlFor({ select: upstream }), { language: "duckdb", keywordCase: "upper", tabWidth: 2 });
    const outputSQL = format(sqlFor({ select: final }), { language: "duckdb", keywordCase: "upper", tabWidth: 2 });
    parseSelect(upstreamSQL);
    parseSelect(outputSQL);
    return { enabled: true, needsSchema: false, direction, upstreamSQL, outputSQL, upstreamSchema };
  } catch (error) {
    return { enabled: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
