import type { SQLDependencyShape } from "./sqlDependencies";
import { quoteIdentifier } from "../src/duckdb/sql";

export type SelectionOperation = "UNION ALL" | "UNION" | "JOIN" | "INTERSECT" | "EXCEPT" | "DIFF";
export type KeyMapping = string[];
export type SelectionQuery = { sql: string };

export function getSelectionSchema(input: SQLDependencyShape) {
  if (input.props.isRunning || input.props.error) return null;
  if (input.type === "data-source") return input.props.metadata;
  if (input.props.isDirty || input.props.stale) return null;
  return input.props.outputSchema;
}

export function getSetOperationError(inputs: SQLDependencyShape[]): string | null {
  const schemas = inputs.map(getSelectionSchema).filter((schema) => schema !== null);
  if (schemas.some((schema) => schema.length === 0)) return "The inputs need columns to combine.";
  if (schemas.some((schema) => schema.length !== schemas[0].length)) {
    return "The inputs have different numbers of columns. Select compatible results.";
  }
  return null;
}

export function getKeyOperationError(inputs: SQLDependencyShape[]): string | null {
  if (inputs.some((input) => !getSelectionSchema(input)?.length)) {
    return "Run the selected queries or load their sources first to choose matching columns.";
  }
  return null;
}

function requireSchema(input: SQLDependencyShape) {
  const schema = getSelectionSchema(input);
  if (!schema?.length) throw new Error(`Run or load ${input.props.name} first to get its columns.`);
  return schema;
}

function table(input: SQLDependencyShape) {
  return quoteIdentifier(input.props.name);
}

function column(alias: string, name: string) {
  return `${alias}.${quoteIdentifier(name)}`;
}

export function buildSelectionQuery(
  operation: SelectionOperation,
  inputs: SQLDependencyShape[],
  keys: KeyMapping[] = []
): SelectionQuery {
  if (inputs.length < 2) throw new Error("Select at least two datasets.");
  if (operation !== "JOIN" && operation !== "DIFF") {
    const error = getSetOperationError(inputs);
    if (error) throw new Error(error);
    return { sql: inputs.map((input) => `SELECT * FROM ${table(input)}`).join(`\n${operation}\n`) };
  }

  if (operation === "DIFF" && inputs.length !== 2) throw new Error("Select exactly two datasets to compare.");
  if (operation === "DIFF" && keys.length === 0) return buildRowDiff(inputs);
  if (keys.length === 0) throw new Error("Choose matching keys first.");
  const schemas = inputs.map(requireSchema);
  for (const mapping of keys) {
    if (
      mapping.length !== inputs.length ||
      mapping.some((key, index) => !schemas[index].some((candidate) => candidate.name === key))
    ) {
      throw new Error("Choose a matching column for every input and key.");
    }
  }

  if (operation === "JOIN") {
    const columns = schemas.flatMap((schema, index) =>
      schema.map(({ name }) => `${column(`t${index + 1}`, name)} AS ${quoteIdentifier(`input${index + 1}_${name}`)}`)
    );
    const joins = inputs.slice(1).map((input, index) => {
      const alias = `t${index + 2}`;
      const condition = keys.map((key) => `${column("t1", key[0])} = ${column(alias, key[index + 1])}`).join(" AND ");
      return `INNER JOIN ${table(input)} AS ${alias}\n  ON ${condition}`;
    });
    return { sql: `SELECT\n  ${columns.join(",\n  ")}\nFROM ${table(inputs[0])} AS t1\n${joins.join("\n")}` };
  }

  const [before, after] = schemas;
  const names = new Set(schemas.flatMap((schema) => schema.map(({ name }) => name.toLowerCase())));
  let marker = "__kavla_present";
  while (names.has(marker.toLowerCase())) marker += "_";
  const condition = keys
    .map((key) => `${column("a", key[0])} IS NOT DISTINCT FROM ${column("b", key[1])}`)
    .join(" AND ");
  const beforeKeys = new Set(keys.map((key) => key[0]));
  const afterKeys = new Set(keys.map((key) => key[1]));
  const beforeValues = before.filter(({ name }) => !beforeKeys.has(name));
  const afterValues = after.filter(({ name }) => !afterKeys.has(name));
  const matchingValues = beforeValues.map((left) => ({
    left,
    right: afterValues.find((right) => right.name.toLowerCase() === left.name.toLowerCase()),
  }));
  const schemaChanged = beforeValues.length !== afterValues.length || matchingValues.some(({ right }) => !right);
  const changed = schemaChanged
    ? "TRUE"
    : matchingValues
        .map(({ left, right }) => `${column("a", left.name)} IS DISTINCT FROM ${column("b", right!.name)}`)
        .join("\n  OR ") || "FALSE";
  const columns = [
    ...before.map(({ name }) => `${column("a", name)} AS ${quoteIdentifier(`before_${name}`)}`),
    ...after.map(({ name }) => `${column("b", name)} AS ${quoteIdentifier(`after_${name}`)}`),
  ];
  const missingBefore = `${column("a", marker)} IS NULL`;
  const missingAfter = `${column("b", marker)} IS NULL`;
  // A scalar subquery fails on duplicate keys, including on later reruns of the saved query.
  const checkedInputs = inputs.map((input, index) => {
    const match = keys
      .map((key) => `${column("key_check", key[index])} IS NOT DISTINCT FROM ${column("source_row", key[index])}`)
      .join(" AND ");
    return `SELECT source_row.*,\n    (SELECT TRUE FROM ${table(input)} AS key_check\n     WHERE ${match}) AS ${quoteIdentifier(marker)}\n  FROM ${table(input)} AS source_row`;
  });
  const sql = `-- A is before; B is after. Matching keys must uniquely identify records.\n-- Scalar subqueries reject duplicate keys; add keys if multiple rows match.\nSELECT\n  CASE\n    WHEN ${missingBefore} THEN 'added'\n    WHEN ${missingAfter} THEN 'removed'\n    ELSE 'changed'\n  END AS change_type,\n  ${columns.join(",\n  ")}\nFROM (\n  ${checkedInputs[0]}\n) AS a\nFULL OUTER JOIN (\n  ${checkedInputs[1]}\n) AS b\n  ON ${condition}\nWHERE ${missingBefore}\n  OR ${missingAfter}\n  OR ${changed}`;
  return { sql };
}

function buildRowDiff(inputs: SQLDependencyShape[]): SelectionQuery {
  const error = getSetOperationError(inputs);
  if (error) throw new Error(error);
  const schemas = inputs.map(requireSchema);
  const [before, after] = schemas;
  if (before.some((column, index) => column.name.toLowerCase() !== after[index].name.toLowerCase())) {
    throw new Error("Whole-row diff needs the same column names in the same order. Choose matching keys instead.");
  }
  let label = "change_type";
  while (before.some(({ name }) => name.toLowerCase() === label.toLowerCase())) label += "_";
  return {
    sql: `-- A is before; B is after. Compare distinct rows.\nSELECT 'removed' AS ${quoteIdentifier(label)}, removed.*\nFROM (\n  SELECT * FROM ${table(inputs[0])}\n  EXCEPT\n  SELECT * FROM ${table(inputs[1])}\n) AS removed\nUNION ALL\nSELECT 'added' AS ${quoteIdentifier(label)}, added.*\nFROM (\n  SELECT * FROM ${table(inputs[1])}\n  EXCEPT\n  SELECT * FROM ${table(inputs[0])}\n) AS added`,
  };
}
