import type { Editor } from "tldraw";
import type { DataSourceShape } from "../DataSource/data-source-types";
import { getRemoteSourceMetadata } from "../DataSource/remote-source-metadata";
import { quoteDottedIdentifier } from "../src/duckdb/sql";
import { getEngineAppearance, type ShapeEngineTab } from "../util/ShapeEngineTabs";
import { getOrderedDependenciesForSQL, type SQLDependencyShape } from "./sqlDependencies";

export type QueryExecutionState = {
  isRemoteExecution: boolean;
  sourceName?: string;
  sourceType: string | null;
  sourceNativePreview: boolean;
  tabs: ShapeEngineTab[];
};

type MountedFileSource = {
  sourceName: string;
  blobId: string;
  fileName: string;
};

type RemoteFileSourcePlan = {
  mountedFileSources: MountedFileSource[];
  validationMessage: string | null;
};

export type SQLDagExecutionPlan = {
  executionState: QueryExecutionState;
  mountedFileSources: MountedFileSource[];
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

export function getMountedFileSourcesForRemoteExecution(
  orderedDependencies: SQLDependencyShape[]
): RemoteFileSourcePlan {
  const mountedFileSources: MountedFileSource[] = [];
  for (const dependency of orderedDependencies) {
    if (dependency.type !== "data-source") {
      continue;
    }

    if (getRemoteSourceMetadata(dependency)) {
      continue;
    }

    if (!dependency.props.filename) {
      return {
        mountedFileSources: [],
        validationMessage: `Source "${dependency.props.name}" is missing file metadata. Re-import it before joining CLI sources.`,
      };
    }

    mountedFileSources.push({
      sourceName: dependency.props.name,
      blobId: `source:${dependency.id}`,
      fileName: dependency.props.filename,
    });
  }

  return { mountedFileSources, validationMessage: null };
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
      isRemoteExecution: false,
      sourceType: null,
      sourceNativePreview: false,
      tabs: [
        {
          key: "query-execution-duckdb-local",
          type: "duckdb",
          active: true,
          layerZIndex: 0,
          title: "Query runs in browser DuckDB",
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
      isRemoteExecution: true,
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
    isRemoteExecution: true,
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
  const remoteFileSourcePlan = executionState.isRemoteExecution
    ? getMountedFileSourcesForRemoteExecution(orderedDependencies)
    : { mountedFileSources: [], validationMessage: null };

  if (remoteFileSourcePlan.validationMessage) {
    return {
      ok: false,
      error: {
        title: "Local file unavailable",
        message: remoteFileSourcePlan.validationMessage,
      },
    };
  }

  return {
    ok: true,
    plan: {
      executionState,
      mountedFileSources: remoteFileSourcePlan.mountedFileSources,
      nextUpstreamShapeIds,
      orderedDependencies,
    },
  };
}

export function buildRemoteSQLFromDag(sqlText: string, orderedDependencies: SQLDependencyShape[]): string {
  const ctes = orderedDependencies
    .filter((dependency) => dependency.type === "sql-text-area")
    .map((dependency) => `"${dependency.props.name}" AS (${dependency.props.text})`);

  let finalSQL = ctes.length > 0 ? `WITH ${ctes.join(",\n")} \n${sqlText}` : sqlText;

  for (const dependency of orderedDependencies) {
    if (dependency.type !== "data-source") {
      continue;
    }

    const remoteSource = getRemoteSourceMetadata(dependency);
    if (!remoteSource) {
      continue;
    }

    const quotedTableName = quoteDottedIdentifier(remoteSource.remoteTableRef);
    const shapeNamePattern = new RegExp(`\\b${dependency.props.name}\\b`, "g");
    finalSQL = finalSQL.replace(shapeNamePattern, quotedTableName);
  }

  return finalSQL;
}
