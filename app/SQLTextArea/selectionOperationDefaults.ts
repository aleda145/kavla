import type { SQLDependencyShape } from "./sqlDependencies";
import { getSelectionSchema, type KeyMapping } from "./selectionOperations";

function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function normalize(name: string): string {
  return words(name).join("");
}

function typeFamily(type: string): string {
  const name = type.toUpperCase().trim();
  if (/[\[\]<>]/.test(name)) return name;
  if (
    /^(U?(TINY|SMALL|BIG|HUGE)?INT(EGER|\d*)?|FLOAT\d*|DOUBLE( PRECISION)?|REAL|NUMERIC|DECIMAL|NUMBER)\b/.test(name)
  ) {
    return "number";
  }
  if (/^(VARCHAR|CHAR|BPCHAR|TEXT|STRING)\b/.test(name)) return "text";
  return name;
}

function singular(name: string): string {
  if (name.endsWith("ies")) return `${name.slice(0, -3)}y`;
  return name.endsWith("s") && !name.endsWith("ss") ? name.slice(0, -1) : name;
}

export function suggestSelectionKey(
  inputs: SQLDependencyShape[],
  operation: "JOIN" | "DIFF",
  existingKeys: KeyMapping[] = []
): KeyMapping | null {
  const schemas = inputs.map(getSelectionSchema);
  if (schemas.length < 2 || schemas.some((schema) => !schema?.length)) return null;
  let best: { mapping: KeyMapping; score: number } | null = null;
  const candidates = new Set(schemas.flatMap((schema) => schema!.map((column) => column.name)));

  for (const name of candidates) {
    const tokens = words(name);
    const normalized = normalize(name);
    const isId = tokens.some((token) => ["id", "uuid", "guid", "identifier"].includes(token));
    const isKey = tokens.includes("key");
    const isCode = tokens.includes("code");
    const isEmail = normalized === "email" || normalized === "emailaddress";
    if (!isId && !isKey && !isCode && !isEmail) continue;

    const generic = ["id", "uuid", "guid", "identifier", "key"].includes(normalized);
    const entity = normalize(
      tokens.filter((token) => !["id", "uuid", "guid", "identifier", "key"].includes(token)).join("_")
    );
    const columns = schemas.map((schema, index) => {
      const exact = schema!.filter((column) => normalize(column.name) === normalized);
      if (exact.length > 0) return exact.length === 1 ? exact[0] : undefined;
      // A generic primary key can match an entity key when its table names that entity.
      const inputNames = words(inputs[index].props.name);
      const matchesEntity =
        inputNames.some((token) => singular(token) === entity) || singular(inputNames.join("")) === entity;
      if (generic || !entity || !matchesEntity || (!isId && !isKey)) return undefined;
      const primary = schema!.filter((column) =>
        (isId ? ["id", "uuid", "guid", "identifier"] : ["key"]).includes(normalize(column.name))
      );
      return primary.length === 1 ? primary[0] : undefined;
    });
    if (columns.some((column) => !column)) continue;
    const matched = columns.filter((column) => column !== undefined);
    if (matched.some((column) => typeFamily(column.type) !== typeFamily(matched[0].type))) continue;
    const mapping = matched.map((column) => column.name);
    if (existingKeys.some((key) => key.some((column, index) => column === mapping[index]))) continue;

    // Prefer an entity relationship for joins, and a row's own ID for comparisons.
    const score = isId ? (generic ? (operation === "DIFF" ? 130 : 100) : 120) : isKey ? 80 : isCode ? 60 : 50;
    if (!best || score > best.score) best = { mapping, score };
  }
  return best?.mapping ?? null;
}

export function getSelectionOperationDefaults(
  operation: "JOIN" | "EXCEPT" | "DIFF",
  selectedInputs: SQLDependencyShape[]
) {
  if (selectedInputs.length < 2) throw new Error("Select at least two datasets.");
  const inputs = [...selectedInputs];
  if (operation === "DIFF" && inputs.length === 2) {
    const timeRank = (input: SQLDependencyShape) => {
      const tokens = words(input.props.name);
      const before = tokens.some((token) => ["before", "old", "previous", "original", "baseline"].includes(token));
      const after = tokens.some((token) => ["after", "new", "current", "updated", "latest"].includes(token));
      return Number(after) - Number(before);
    };
    if (timeRank(inputs[0]) > timeRank(inputs[1])) inputs.reverse();
  }
  if (operation === "EXCEPT") {
    const keepRank = (input: SQLDependencyShape) => {
      const tokens = words(input.props.name);
      const keep = tokens.some((token) => ["all", "original", "base", "full", "complete"].includes(token));
      const remove = tokens.some((token) =>
        ["excluded", "blocked", "removed", "deleted", "exclude", "exclusions"].includes(token)
      );
      return Number(keep) - Number(remove);
    };
    const first = inputs.reduce((best, input) => (keepRank(input) > keepRank(best) ? input : best));
    inputs.splice(inputs.indexOf(first), 1);
    inputs.unshift(first);
  }
  const key = operation === "EXCEPT" ? null : suggestSelectionKey(inputs, operation);
  let useKeys = operation === "JOIN" || (operation === "DIFF" && key !== null);
  if (operation === "DIFF" && !useKeys) {
    const before = getSelectionSchema(inputs[0]);
    const after = getSelectionSchema(inputs[1]);
    if (before && after) {
      useKeys =
        before.length !== after.length ||
        before.some((column, index) => column.name.toLowerCase() !== after[index].name.toLowerCase());
    }
  }
  return {
    inputIds: inputs.map((input) => input.id),
    useKeys,
    keys: [key ?? inputs.map(() => "")],
  };
}
