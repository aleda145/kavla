import type { Editor } from "tldraw";
import type { DataSourceShape } from "../DataSource/data-source-types";
import { getRemoteSourceMetadata } from "../DataSource/remote-source-metadata";
import { quoteDottedIdentifier, quoteIdentifier, stripTrailingSemicolons } from "../src/duckdb/sql";
import { getEngineAppearance, type ShapeEngineTab } from "../util/ShapeEngineTabs";
import { getOrderedDependenciesForSQL, type SQLDependencyShape } from "./sqlDependencies";

export type QueryExecutionState = {
  sourceName?: string;
  sourceType: string | null;
  sourceNativePreview: boolean;
  tabs: ShapeEngineTab[];
};

export type SQLDagExecutionPlan = {
  executionState: QueryExecutionState;
  nextUpstreamShapeIds: string[];
  orderedDependencies: SQLDependencyShape[];
};

type SQLDagWalkResult =
  | {
      ok: true;
      plan: SQLDagExecutionPlan;
    }
  | {
      ok: false;
      error: {
        title: string;
        message: string;
      };
    };

export function getMissingSourceMessage(orderedDependencies: SQLDependencyShape[]): string | null {
  const missing = orderedDependencies.find(dependency => dependency.type === "data-source" && !getRemoteSourceMetadata(dependency));
  return missing ? `Source "${missing.props.name}" is missing its uploaded table. Upload the file again.` : null;
}

export function describeQueryExecution(orderedDependencies: SQLDependencyShape[]): QueryExecutionState {
  const remoteSources = orderedDependencies
    .filter((dependency): dependency is DataSourceShape => dependency.type === "data-source")
    .flatMap((dependency) => {
      const remoteSource = getRemoteSourceMetadata(dependency);
      return remoteSource ? [remoteSource] : [];
    });

  if (!remoteSources.length) {
    return {
      sourceType: null,
      sourceNativePreview: false,
      tabs: [
        {
          key: "query-execution-duckdb-local",
          type: "duckdb",
          active: true,
          layerZIndex: 0,
          title: "Query runs in backend DuckDB",
        },
      ],
    };
  }

  const uniqueRemoteSourceNames = Array.from(new Set(remoteSources.map((remoteSource) => remoteSource.sourceName)));
  const sourceName = uniqueRemoteSourceNames.length === 1 ? uniqueRemoteSourceNames[0] : undefined;
  const sourceType = uniqueRemoteSourceNames.length === 1 ? (remoteSources[0]?.sourceType ?? null) : null;
  const uniqueRemoteSourceTypes = Array.from(
    new Set(remoteSources.map((remoteSource) => remoteSource.sourceType).filter((value): value is string => !!value))
  );
  const mountedFileDependencyCount = orderedDependencies.filter(
    (dependency) => dependency.type === "data-source" && !getRemoteSourceMetadata(dependency)
  ).length;
  const readSourceSummary = [
    ...(mountedFileDependencyCount > 0
      ? [`${mountedFileDependencyCount} local file source${mountedFileDependencyCount === 1 ? "" : "s"}`]
      : []),
    ...uniqueRemoteSourceNames,
  ].join(", ");

  const sourceNativePreview =
    Boolean(sourceName && sourceType) &&
    mountedFileDependencyCount === 0 &&
    orderedDependencies.every((dependency) => {
      if (dependency.type !== "data-source") {
        return true;
      }

      const remoteSource = getRemoteSourceMetadata(dependency);
      if (!remoteSource) {
        return false;
      }

      return remoteSource.sourceName === sourceName;
    }) &&
    uniqueRemoteSourceTypes.length === 1;

  if (sourceNativePreview) {
    const appearance = getEngineAppearance(sourceType);
    return {
      sourceName,
      sourceType,
      sourceNativePreview: true,
      tabs: [
        {
          key: `query-execution-${sourceType}`,
          type: sourceType,
          active: true,
          layerZIndex: 0,
          title: `Query runs natively in ${appearance.label}`,
          details: [`Source: ${sourceName}`],
        },
      ],
    };
  }

  const inactiveRemoteTypes = Array.from(
    new Set(
      remoteSources.map((remoteSource) => remoteSource.sourceType ?? "remote").filter((type) => type !== "duckdb")
    )
  );

  return {
    sourceName,
    sourceType,
    sourceNativePreview: false,
    tabs: [
      {
        key: "query-execution-duckdb-federated",
        type: "duckdb",
        active: true,
        layerZIndex: 0,
        title: "Query runs federated in CLI DuckDB",
        details: [`Reads from: ${readSourceSummary}`],
        topOffset: 2,
      },
      ...inactiveRemoteTypes.map((type) => {
        const appearance = getEngineAppearance(type);
        const sourceNamesForType = Array.from(
          new Set(
            remoteSources
              .filter((remoteSource) => (remoteSource.sourceType ?? "remote") === type)
              .map((remoteSource) => remoteSource.sourceName)
          )
        );
        return {
          key: `query-remote-${type}`,
          type,
          active: false,
          layerZIndex: 0,
          title: `Reads from ${appearance.label} during federation`,
          details: [`Source: ${sourceNamesForType.join(", ")}`],
        };
      }),
    ],
  };
}

export function walkSQLDag(editor: Editor, sqlText: string): SQLDagWalkResult {
  const { orderedDependencies, immediateUpstreamIds } = getOrderedDependenciesForSQL(editor, sqlText);
  const nextUpstreamShapeIds = Array.from(new Set(immediateUpstreamIds));

  const executionState = describeQueryExecution(orderedDependencies);
  const missingSourceMessage = getMissingSourceMessage(orderedDependencies);

  if (missingSourceMessage) {
    return {
      ok: false,
      error: {
        title: "Local file unavailable",
        message: missingSourceMessage,
      },
    };
  }

  return {
    ok: true,
    plan: {
      executionState,
      nextUpstreamShapeIds,
      orderedDependencies,
    },
  };
}

export function buildRemoteSQLFromDag(sqlText: string, orderedDependencies: SQLDependencyShape[]): string {
  const ctes = orderedDependencies.map(dependency => {
    if (dependency.type === "sql-text-area") return `${quoteIdentifier(dependency.props.name)} AS (${stripTrailingSemicolons(dependency.props.text)})`;
    const source = getRemoteSourceMetadata(dependency);
    if (!source) throw new Error(`Source "${dependency.props.name}" is unavailable.`);
    return `${quoteIdentifier(dependency.props.name)} AS (SELECT * FROM ${quoteDottedIdentifier(source.remoteTableRef)})`;
  });
  const query = stripTrailingSemicolons(sqlText);
  return ctes.length ? `WITH ${ctes.join(",\n")} SELECT * FROM (${query}) AS kavla_query` : query;
}
