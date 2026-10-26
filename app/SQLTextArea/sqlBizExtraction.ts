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

function unalias(expression: ast.Expression) {
  return "alias" in expression ? expression.alias.this : expression;
}

function hasValue(value: unknown) {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

export function planSQLBizExtraction(
  sql: string,
  step: BizStep,
  source: { name: string; columns: Column[] | null },
  upstreamName: string,
  outputSchema: Column[] | null = null
): BizExtractionPlan {
  try {
    requireSafe(!step.scope, "Extracting an operation inside a CTE, subquery, or set operation is not supported yet.");
    requireSafe(
      !["READ", "SELECT", "JOIN", "COMBINE", "WINDOW", "FILTER WINDOW", "FILTER GROUPS"].includes(step.label),
      step.label === "SELECT"
        ? "There is no separate operation to extract."
        : `${step.label} has dependencies that cannot yet be separated safely.`
    );
    let hasKnobs = false;
    mapKnobParameters(sql, () => {
      hasKnobs = true;
      return "0";
    });
    requireSafe(!hasKnobs, "Queries with knob parameters cannot be extracted yet.");
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
      "qualify",
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
      "This query contains clauses that cannot yet be separated safely (such as joins, CTEs, windows, or DISTINCT ON)."
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
    ast.walk(
      { select: query },
      {
        enter(node) {
          const type = ast.getExprType(node);
          if (type === "select") selectCount++;
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
      requireSafe(
        !query.limit && !query.offset && !query.fetch,
        "SORT must stay before LIMIT and OFFSET; extract those first."
      );
    } else if (step.label === "LIMIT") {
      requireSafe(query.limit || query.fetch, "This query no longer contains that limit.");
      requireSafe(
        !query.fetch?.percent && !query.fetch?.with_ties,
        "Percentage limits and WITH TIES cannot be extracted yet."
      );
    } else if (step.label === "SKIP") {
      requireSafe(query.offset, "This query no longer contains that offset.");
      requireSafe(!query.limit && !query.fetch, "OFFSET must stay before LIMIT; extract LIMIT first.");
    } else if (step.label === "DEDUPLICATE") {
      requireSafe(
        query.distinct && !query.order_by && !query.limit && !query.offset && !query.fetch,
        "DISTINCT must stay before sorting and row limits; extract those first."
      );
    } else if (step.label === "AGGREGATE") {
      requireSafe(
        !query.having && !query.order_by && !query.limit && !query.offset && !query.fetch && !query.distinct,
        "Extract the operations after AGGREGATE first; HAVING must stay with its aggregate."
      );
      requireSafe(
        query.expressions.every((item) => "column" in unalias(item) || ast.getAggregateFunctions(item).length > 0),
        "Extract calculated grouping columns before separating the aggregate."
      );
      requireSafe(!query.group_by?.all, "GROUP BY ALL cannot be separated safely yet.");
    } else if (transformOperations.has(step.label)) {
      requireSafe(
        !query.where_clause && !query.having,
        "Extract the filter first so expression evaluation stays after filtering."
      );
      requireSafe(
        !query.expressions.some((item) => "star" in item),
        "A wildcard projection would gain the extracted column."
      );
    }
    if (source.columns === null) {
      return {
        enabled: true,
        needsSchema: true,
        direction: step.label === "FILTER" || transformOperations.has(step.label) ? "upstream" : "downstream",
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
      if (query.group_by || ast.getAggregateFunctions({ select: query }).length) {
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
          const order = item.this;
          let match =
            "column" in order && !order.column.table
              ? outputs.find((output) => output.name.toLowerCase() === order.column.name.name.toLowerCase())
              : undefined;
          match ??= outputs.find((output) => sqlFor(output.expression) === sqlFor(order));
          if (!match && "column" in order) {
            match = outputs.find(
              (output) =>
                "column" in output.expression &&
                output.expression.column.name.name.toLowerCase() === order.column.name.name.toLowerCase()
            );
          }
          requireSafe(match, "The sort uses an expression or column that is not exposed by the query output.");
          return { ...item, this: column(match.name) };
        }),
      };
      upstream = structuredClone(query);
      final = parseSelect(`SELECT * FROM ${quoteIdentifier(upstreamName)}`);
      upstreamSchema = outputSchema;
      if (step.label === "SORT") {
        upstream.order_by = null;
        final.order_by = mappedOrder;
      } else if (step.label === "LIMIT") {
        upstream.limit = null;
        upstream.fetch = null;
        final.limit = query.limit;
        final.fetch = query.fetch;
        // Reassert ordering at the output boundary; subquery order is not a contract.
        final.order_by = mappedOrder;
      } else if (step.label === "SKIP") {
        upstream.offset = null;
        final.offset = query.offset;
        final.order_by = mappedOrder;
      } else if (step.label === "DEDUPLICATE") {
        upstream.distinct = false;
        final.distinct = true;
      } else if (step.label === "AGGREGATE") {
        if (query.where_clause) readsOnlyInput(query.where_clause.this);
        upstream = sourceSelect;
        upstream.where_clause = query.where_clause;
        final = output;
        final.where_clause = null;
        upstreamSchema = sourceColumns;
      } else {
        throw new Error("This operation cannot be extracted safely yet.");
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
