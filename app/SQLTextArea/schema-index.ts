import type { TLShapeId } from "tldraw";
import type { SchemaRegistry } from "../hooks/useSchemaRegistry";
import type { SqlColumnDefinition } from "./sql-identifiers";

export interface SqlSchemaIndex {
  schemaConfig: Record<string, string[]>;
  fullSchemaConfig: Record<string, { name: string; type: string }[]>;
  tableNames: Set<string>;
  allColumns: SqlColumnDefinition[];
  sources: Set<string>;
  queries: Set<string>;
  columnMapping: Record<string, SqlColumnDefinition[]>;
  tableNameToId: Map<string, TLShapeId>;
}

export function buildSqlSchemaIndex(registry: SchemaRegistry): SqlSchemaIndex {
  const schemaConfig: Record<string, string[]> = {};
  const fullSchemaConfig: Record<string, { name: string; type: string }[]> = {};
  const tableNames = new Set<string>();
  const allColumns: SqlColumnDefinition[] = [];
  const sources = new Set<string>();
  const queries = new Set<string>();
  const columnMapping: Record<string, SqlColumnDefinition[]> = {};
  const tableNameToId = new Map<string, TLShapeId>();

  for (const [shapeId, entry] of Object.entries(registry)) {
    tableNames.add(entry.tableName);
    schemaConfig[entry.tableName] = entry.columns.map((column) => column.name);
    fullSchemaConfig[entry.tableName] = entry.columns;
    tableNameToId.set(entry.tableName, shapeId as TLShapeId);

    if (entry.type === "data-source") {
      sources.add(entry.tableName);
    } else {
      queries.add(entry.tableName);
    }

    for (const column of entry.columns) {
      const definition = {
        tableName: entry.tableName,
        type: column.type,
        name: column.name,
      };
      allColumns.push(definition);
      const normalizedName = column.name.toLowerCase();
      (columnMapping[normalizedName] ??= []).push(definition);
    }
  }

  return {
    schemaConfig,
    fullSchemaConfig,
    tableNames,
    allColumns,
    sources,
    queries,
    columnMapping,
    tableNameToId,
  };
}
