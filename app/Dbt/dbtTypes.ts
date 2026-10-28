import type { TLBaseShape } from "tldraw";

export type DbtBinding = { id: string; root: string; sourceName?: string };
export type DbtFile = {
  path: string;
  kind: string;
  text: string;
  revision: string;
  readOnly: boolean;
  size: number;
  dependsOn: string[];
};
export type DbtProject = {
  binding: DbtBinding | null;
  name: string;
  files: DbtFile[];
  warnings: string[];
  sources?: DbtSourceDefinition[];
  documentation?: DbtDocumentation[];
};
export type DbtFileShape = TLBaseShape<
  "dbt-file",
  {
    w: number;
    h: number;
    bindingId: string;
    projectRoot: string;
    path: string;
    kind: string;
    text: string;
    baseText: string;
    revision: string;
    readOnly: boolean;
  }
>;
export type DbtIssue = { kind: "conflict" | "missing" | "error" | "duplicate"; message: string; disk?: DbtFile };

export type DbtLink = Omit<DbtFileShape["props"], "w" | "h" | "text"> & { projectName: string; refName: string };
export type DbtFileView = Omit<DbtFileShape, "type"> & { type: "dbt-file" | "sql-text-area" | "dbt-macro" };
export type DbtSourceDefinition = { source: string; table: string; schema: string; identifier: string; path: string };

export type DbtDocumentation = {
  name: string;
  kind: string;
  source?: string;
  path: string;
  description: string;
  sourceDescription?: string;
  tags: string[];
  tests: string[];
  materialized?: string;
  columns: { name: string; description: string; dataType: string; tests: string[] }[];
};

export type DbtMacroShape = TLBaseShape<
  "dbt-macro",
  DbtFileShape["props"] & {
    name: string;
    upstreamShapeIds: string[] | null;
    downstreamShapeIds: string[] | null;
  }
>;
