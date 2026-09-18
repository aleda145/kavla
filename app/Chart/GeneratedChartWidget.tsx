import { LensRuntimeUnavailableError } from "../Lens/lens-errors";
import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactECharts from "echarts-for-react";
import * as ECharts from "echarts";
import { tableFromArrays } from "apache-arrow";
import { DuckDBService } from "@/duckdb-service";
import { quoteIdentifier } from "../src/duckdb/sql";
import { getLensVizRuntime } from "../Lens/viz/runtime";
import type { LensVizRuntime } from "../Lens/viz/runtime";
import "maplibre-gl/dist/maplibre-gl.css";

type GeneratedWidgetLibraries = {
  Plot: any;
  d3: any;
  THREE: any;
  Canvas: any;
  useFrame: any;
  OrbitControls: any;
  MapLibre: any;
  ECharts: typeof ECharts;
};

type GeneratedChartWidgetProps = {
  rows: Record<string, unknown>[];
  allRows: Record<string, unknown>[];
  columns: string[];
  columnTypes: Record<string, string>;
  sourceName: string;
  width: number;
  height: number;
  performance: {
    rowCount: number;
    renderedRowCount: number;
    isSampled: boolean;
    maxDirectRows: number;
    maxSvgMarks: number;
    maxAnimatedMarks: number;
    max3DObjects: number;
  };
  theme: {
    fontFamily: string;
    borderColor: string;
    colors: string[];
    background: string;
    surface: string;
    header: string;
    borderWidth: number;
    radius: number;
    shadow: string;
  };
  viz: LensVizRuntime;
  React: typeof React;
  ReactECharts: typeof ReactECharts & { graphic?: typeof ECharts.graphic };
  ECharts: typeof ECharts;
  Plot: any;
  d3: any;
  THREE: any;
  Canvas: any;
  useFrame: any;
  OrbitControls: any;
  MapLibre: any;
  runSql: (sql: string) => Promise<Record<string, unknown>[]>;
};

type GeneratedChartWidgetViewProps = {
  isSampled?: boolean;
  code: string;
  dataSql?: string | null;
  widgetKey: string;
  rows: Record<string, unknown>[];
  columns: string[];
  columnTypes: Record<string, string>;
  sourceName: string;
  width: number;
  height: number;
  onError?: (errorMessage: string) => void;
  onDataSqlError?: (errorMessage: string) => void;
};

export type GeneratedChartWidgetValidationInput = {
  isSampled?: boolean;
  code: string;
  dataSql?: string | null;
  rows?: Record<string, unknown>[];
  columns?: string[];
  columnTypes?: Record<string, string>;
  sourceName?: string;
  width?: number;
  height?: number;
};

export type GeneratedChartWidgetValidationResult = {
  warning?: string | null;
};

const BLOCKED_CODE_PATTERN = /^\s*(?:import(?!\s*\()|export)\b/m;
const MAX_SVG_MARKS = 500;
const MAX_ANIMATED_MARKS = 200;
const MAX_3D_OBJECTS = 300;
const GENERATED_WIDGET_COMPILER_VERSION = "sucrase-tsx-v1";
const MAX_GENERATED_WIDGET_COMPILE_CACHE_SIZE = 100;

const theme = {
  fontFamily: "Inter, sans-serif",
  borderColor: "#000",
  colors: ["#8b5cf6", "#ec4899", "#3b82f6", "#eab308", "#22c55e", "#14b8a6", "#f97316"],
  background: "#fff",
  surface: "#f9fafb",
  header: "#fce7f3",
  borderWidth: 3,
  radius: 6,
  shadow: "4px 4px 0px 0px rgba(0,0,0,1)",
};

const ReactEChartsRuntime = Object.assign(ReactECharts, {
  graphic: ECharts.graphic,
});

type GeneratedWidgetCompiledFactory = (
  ReactRuntime: typeof React,
  imports: Record<string, any>,
  createScope: typeof createGeneratedWidgetScope,
  updateScope: typeof updateGeneratedWidgetScope
) => React.ComponentType<GeneratedChartWidgetProps>;

type GeneratedWidgetCompileCacheEntry = {
  source: string;
  compiledCode: string;
  sourceMap?: unknown;
  factory: GeneratedWidgetCompiledFactory;
};

const generatedWidgetCompileCache = new Map<string, GeneratedWidgetCompileCacheEntry>();

class GeneratedWidgetErrorBoundary extends React.Component<
  { children: React.ReactNode; onError?: (errorMessage: string) => void },
  { errorMessage: string | null }
> {
  state: { errorMessage: string | null } = { errorMessage: null };

  static getDerivedStateFromError(error: Error) {
    return { errorMessage: error.message || "Generated Lens render failed." };
  }

  componentDidCatch(error: Error) {
    console.error("Generated Lens render failed", error);
    this.props.onError?.(error.message || "Generated Lens render failed.");
  }

  render() {
    if (this.state.errorMessage) {
      return <GeneratedWidgetErrorPanel />;
    }

    return this.props.children;
  }
}

function getGeneratedWidgetErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message || fallback : fallback;
}

function GeneratedWidgetErrorPanel() {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        boxSizing: "border-box",
        color: "#111827",
        fontWeight: 800,
        textAlign: "center",
      }}
    >
      Lens failed to render.
    </div>
  );
}

let generatedWidgetRuntime: Promise<GeneratedWidgetLibraries> | null = null;

// Run this before spending a generation request, and share it with validation and rendering.
export async function prepareGeneratedChartWidgetRuntime(): Promise<void> {
  await loadGeneratedWidgetLibraries();
}

function loadGeneratedWidgetLibraries(): Promise<GeneratedWidgetLibraries> {
  if (generatedWidgetRuntime) return generatedWidgetRuntime;
  generatedWidgetRuntime = (async () => {
    try { new Function("return true")(); }
    catch { throw new LensRuntimeUnavailableError("Lens JavaScript is blocked by Content Security Policy. Restart the updated Kavla server and reload the page. Generating different code cannot fix this."); }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        importGeneratedWidgetLibraries(),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Timed out loading Lens libraries.")), 30000); }),
      ]);
    } catch (error) {
      throw new LensRuntimeUnavailableError(`Lens libraries could not load. Reload the app before retrying. ${error instanceof Error ? error.message : String(error)}`);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  })();
  return generatedWidgetRuntime;
}

async function importGeneratedWidgetLibraries(): Promise<GeneratedWidgetLibraries> {
  const [Plot, d3, THREE, fiber, drei, MapLibre] = await Promise.all([
    import("@observablehq/plot"),
    import("d3"),
    import("three"),
    import("@react-three/fiber"),
    import("@react-three/drei"),
    import("maplibre-gl"),
  ]);

  return {
    Plot,
    d3,
    THREE,
    Canvas: fiber.Canvas,
    useFrame: fiber.useFrame,
    OrbitControls: drei.OrbitControls,
    MapLibre,
    ECharts,
  };
}

function getGeneratedWidgetImportRuntime(libraries: GeneratedWidgetLibraries) {
  return {
    react: { ...React, default: React },
    "echarts-for-react": { default: ReactEChartsRuntime, graphic: ECharts.graphic },
    echarts: { ...ECharts, default: ECharts },
    d3: { ...libraries.d3, default: libraries.d3 },
    three: { ...libraries.THREE, default: libraries.THREE },
    "@react-three/fiber": { Canvas: libraries.Canvas, useFrame: libraries.useFrame },
    "@react-three/drei": { OrbitControls: libraries.OrbitControls },
    "maplibre-gl": { ...libraries.MapLibre, default: libraries.MapLibre.default ?? libraries.MapLibre },
    "@observablehq/plot": { ...libraries.Plot, default: libraries.Plot },
  } as Record<string, any>;
}

function getImportModuleExpression(moduleName: string) {
  const allowedModules = new Set([
    "react",
    "echarts-for-react",
    "echarts",
    "d3",
    "three",
    "@react-three/fiber",
    "@react-three/drei",
    "maplibre-gl",
    "@observablehq/plot",
  ]);

  if (!allowedModules.has(moduleName)) {
    throw new Error(`Generated Lens import "${moduleName}" is not available. Use the injected Lens props instead.`);
  }

  return `__imports[${JSON.stringify(moduleName)}]`;
}

function buildNamedImportBindings(specifier: string, moduleExpression: string) {
  const bindings = specifier
    .replace(/^\{|\}$/g, "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [imported, local] = part.split(/\s+as\s+/).map((value) => value.trim());
      return local && local !== imported ? `${imported}: ${local}` : imported;
    });

  return bindings.length ? `const { ${bindings.join(", ")} } = ${moduleExpression};` : "";
}

function rewriteGeneratedWidgetModuleSyntax(code: string) {
  let rewritten = code.replace(/^\s*import\s+["']([^"']+)["'];?\s*$/gm, (_match, moduleName: string) => {
    if (moduleName === "maplibre-gl/dist/maplibre-gl.css") {
      return "";
    }
    throw new Error(
      `Generated Lens side-effect import "${moduleName}" is not available. Use the injected Lens props instead.`
    );
  });

  rewritten = rewritten.replace(
    /^\s*import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];?\s*$/gm,
    (_match, rawSpecifier: string, moduleName: string) => {
      const specifier = rawSpecifier.trim();
      const moduleExpression = getImportModuleExpression(moduleName);

      if (specifier.startsWith("type ")) {
        return "";
      }

      if (/^\*\s+as\s+/.test(specifier)) {
        const localName = specifier.replace(/^\*\s+as\s+/, "").trim();
        return `const ${localName} = ${moduleExpression};`;
      }

      if (specifier.startsWith("{")) {
        return buildNamedImportBindings(specifier, moduleExpression);
      }

      const commaIndex = specifier.indexOf(",");
      if (commaIndex >= 0) {
        const defaultName = specifier.slice(0, commaIndex).trim();
        const namedSpecifier = specifier.slice(commaIndex + 1).trim();
        return [
          `const ${defaultName} = ${moduleExpression}.default ?? ${moduleExpression};`,
          namedSpecifier.startsWith("{") ? buildNamedImportBindings(namedSpecifier, moduleExpression) : "",
        ]
          .filter(Boolean)
          .join("\n");
      }

      return `const ${specifier} = ${moduleExpression}.default ?? ${moduleExpression};`;
    }
  );

  rewritten = rewritten
    .replace(/^\s*export\s+default\s+function\s+([A-Za-z_$][\w$]*)?\s*\(/gm, (_match, name: string) => {
      return `function ${name || "Lens"}(`;
    })
    .replace(/^\s*export\s+(function|const|let|var|class|interface|type|enum)\s+/gm, "$1 ")
    .replace(
      /^\s*export\s+default\s+([A-Za-z_$][\w$]*);?\s*$/gm,
      (_match, name: string) => `const Lens = typeof ${name} !== "undefined" ? ${name} : undefined;`
    )
    .replace(/^\s*export\s+default\s+([^;\n]+);?\s*$/gm, "const Lens = $1;")
    .replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, "");

  if (BLOCKED_CODE_PATTERN.test(rewritten)) {
    throw new Error(
      "Generated Lens code contains unsupported import/export syntax. Use the injected Lens props instead."
    );
  }

  return rewritten;
}

function removeTerminalWidgetReturn(code: string) {
  const match = code.match(/\n?\s*return\s+([A-Za-z_$][\w$]*)\s*;?\s*$/);
  if (!match) {
    return { code, returnedName: null };
  }

  return {
    code: code.slice(0, match.index).trimEnd(),
    returnedName: match[1],
  };
}

function getGeneratedWidgetCandidateNames(code: string) {
  const candidates: string[] = [];
  const declarationPattern = /\b(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  let match: RegExpExecArray | null;

  while ((match = declarationPattern.exec(code))) {
    const name = match[1];
    if (!name || candidates.includes(name)) continue;
    if (
      name === "Widget" ||
      name === "widget" ||
      name === "Lens" ||
      name === "GeneratedLens" ||
      name === "GeneratedWidget" ||
      name === "LensWidget" ||
      name === "component" ||
      name === "Component" ||
      name === "App" ||
      /^[A-Z]/.test(name)
    ) {
      candidates.push(name);
    }
  }

  const priority = (name: string) => {
    if (name === "Lens") return 0;
    if (name === "GeneratedLens") return 1;
    if (name === "LensWidget") return 2;
    if (name === "Widget") return 3;
    if (name === "GeneratedWidget") return 4;
    if (/(Lens|Widget|Map|Chart|View|App)$/.test(name)) return 3;
    return 4;
  };

  return candidates.sort((a, b) => priority(a) - priority(b));
}

function hashGeneratedWidgetSource(code: string) {
  let hash = 2166136261;

  for (let i = 0; i < code.length; i++) {
    hash ^= code.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return `${GENERATED_WIDGET_COMPILER_VERSION}:${code.length}:${(hash >>> 0).toString(36)}`;
}

function cacheGeneratedWidgetCompilation(cacheKey: string, entry: GeneratedWidgetCompileCacheEntry) {
  generatedWidgetCompileCache.set(cacheKey, entry);

  if (generatedWidgetCompileCache.size <= MAX_GENERATED_WIDGET_COMPILE_CACHE_SIZE) {
    return;
  }

  const oldestKey = generatedWidgetCompileCache.keys().next().value;
  if (oldestKey) {
    generatedWidgetCompileCache.delete(oldestKey);
  }
}

function createGeneratedWidgetScope(imports: Record<string, any>) {
  const viz = getLensVizRuntime();
  return {
    React,
    ReactECharts: ReactEChartsRuntime as GeneratedChartWidgetProps["ReactECharts"],
    ECharts,
    Plot: imports["@observablehq/plot"].default,
    d3: imports.d3.default,
    THREE: imports.three.default,
    Canvas: imports["@react-three/fiber"].Canvas,
    useFrame: imports["@react-three/fiber"].useFrame,
    OrbitControls: imports["@react-three/drei"].OrbitControls,
    MapLibre: imports["maplibre-gl"].default,
    require: (moduleName: string) => {
      return imports[moduleName] ?? {};
    },
    window: {
      React,
      ReactECharts: ReactEChartsRuntime,
      ECharts,
      Plot: imports["@observablehq/plot"].default,
      d3: imports.d3.default,
      THREE: imports.three.default,
      ReactThreeFiber: imports["@react-three/fiber"],
      OrbitControls: imports["@react-three/drei"].OrbitControls,
      maplibregl: imports["maplibre-gl"].default,
      MapLibre: imports["maplibre-gl"].default,
      viz,
    },
    props: {
      rows: [] as Record<string, unknown>[],
      allRows: [] as Record<string, unknown>[],
      data: [] as Record<string, unknown>[],
      columns: [] as string[],
      columnTypes: {} as Record<string, string>,
      sourceName: "",
      width: 0,
      height: 0,
      performance: null as GeneratedChartWidgetProps["performance"] | null,
      theme,
      viz,
      runSql: async (_sql: string) => [] as Record<string, unknown>[],
    },
    rows: [] as Record<string, unknown>[],
    allRows: [] as Record<string, unknown>[],
    data: [] as Record<string, unknown>[],
    columns: [] as string[],
    columnTypes: {} as Record<string, string>,
    sourceName: "",
    width: 0,
    height: 0,
    performance: null as GeneratedChartWidgetProps["performance"] | null,
    theme,
    viz,
    runSql: async (_sql: string) => [] as Record<string, unknown>[],
  };
}

function updateGeneratedWidgetScope(
  scope: ReturnType<typeof createGeneratedWidgetScope>,
  props: GeneratedChartWidgetProps
) {
  scope.props = {
    ...props,
    data: props.rows,
  };
  scope.rows = props.rows;
  scope.allRows = props.allRows;
  scope.data = props.rows;
  scope.columns = props.columns;
  scope.columnTypes = props.columnTypes;
  scope.sourceName = props.sourceName;
  scope.width = props.width;
  scope.height = props.height;
  scope.performance = props.performance;
  scope.theme = props.theme;
  scope.viz = props.viz;
  scope.ReactECharts = props.ReactECharts as GeneratedChartWidgetProps["ReactECharts"];
  scope.ECharts = props.ECharts;
  scope.Plot = props.Plot;
  scope.d3 = props.d3;
  scope.THREE = props.THREE;
  scope.Canvas = props.Canvas;
  scope.useFrame = props.useFrame;
  scope.OrbitControls = props.OrbitControls;
  scope.MapLibre = props.MapLibre;
  scope.runSql = props.runSql;
}

async function compileGeneratedWidget(code: string, libraries: GeneratedWidgetLibraries) {
  const cacheKey = hashGeneratedWidgetSource(code);
  const cachedEntry = generatedWidgetCompileCache.get(cacheKey);
  let compiledEntry = cachedEntry && cachedEntry.source === code ? cachedEntry : null;

  if (compiledEntry) {
    generatedWidgetCompileCache.delete(cacheKey);
    generatedWidgetCompileCache.set(cacheKey, compiledEntry);
  } else {
    const { code: rewrittenCode, returnedName } = removeTerminalWidgetReturn(rewriteGeneratedWidgetModuleSyntax(code));
    const candidateNames = getGeneratedWidgetCandidateNames(rewrittenCode);
    if (returnedName && !candidateNames.includes(returnedName)) {
      candidateNames.unshift(returnedName);
    }
    const candidatePushes = candidateNames.map((name) => {
      return `if (typeof ${name} !== "undefined") __candidates.push(${name});`;
    });
    const { transform } = await import("sucrase");
    const compiled = transform(rewrittenCode, {
      transforms: ["typescript", "jsx"],
      jsxRuntime: "classic",
      production: true,
      filePath: "Lens.tsx",
      sourceMapOptions: { compiledFilename: `${cacheKey}.js` },
    } as any);

    const factory = new Function(
      "React",
      "__imports",
      "__createScope",
      "__updateScope",
      `
const __scope = __createScope(__imports);
with (__scope) {
  ${compiled.code}
  const __candidates = [];
  if (typeof Lens !== "undefined") __candidates.push(Lens);
  if (typeof GeneratedLens !== "undefined") __candidates.push(GeneratedLens);
  if (typeof Widget !== "undefined") __candidates.push(Widget);
  if (typeof GeneratedWidget !== "undefined") __candidates.push(GeneratedWidget);
  ${candidatePushes.join("\n  ")}
  const __candidate = __candidates.find((candidate) => {
    return typeof candidate === "function" || Boolean(candidate && typeof candidate === "object" && candidate.$$typeof);
  }) ?? null;
  if (!__candidate) {
    throw new Error("Generated Lens code must define or export a React component function.");
  }
  return function GeneratedLensWidgetRuntime(props) {
    __updateScope(__scope, props);
    return React.createElement(__candidate, props);
  };
}`
    ) as GeneratedWidgetCompiledFactory;

    compiledEntry = {
      source: code,
      compiledCode: compiled.code,
      sourceMap: compiled.sourceMap,
      factory,
    };
    cacheGeneratedWidgetCompilation(cacheKey, compiledEntry);
  }

  const component = compiledEntry.factory(
    React,
    getGeneratedWidgetImportRuntime(libraries),
    createGeneratedWidgetScope,
    updateGeneratedWidgetScope
  );
  if (typeof component !== "function") {
    throw new Error("Generated Lens code did not return a React component.");
  }

  return {
    component: component as React.ComponentType<GeneratedChartWidgetProps>,
  };
}

function normalizeSqlRow(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if (typeof value === "bigint") {
        const numberValue = Number(value);
        return [key, Number.isSafeInteger(numberValue) ? numberValue : value.toString()];
      }
      if (value instanceof Date) {
        return [key, value.toISOString()];
      }
      return [key, value];
    })
  );
}

function getRunSqlColumns(rows: Record<string, unknown>[], columns: string[]) {
  const columnSet = new Set(columns);
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      columnSet.add(key);
    }
  }
  return Array.from(columnSet);
}

function createArrowColumnValues(values: unknown[]) {
  const nonNullValues = values.filter((value) => value !== null && value !== undefined);

  if (nonNullValues.length === 0) {
    return values.map(() => null);
  }

  if (nonNullValues.every((value) => typeof value === "number")) {
    return values.map((value) => (typeof value === "number" && Number.isFinite(value) ? value : null));
  }

  if (nonNullValues.every((value) => typeof value === "boolean")) {
    return values.map((value) => (typeof value === "boolean" ? value : null));
  }

  return values.map((value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Date) return value.toISOString();
    return String(value);
  });
}

function createArrowTableFromRows(rows: Record<string, unknown>[], columns: string[]) {
  const normalizedRows = rows.map(normalizeSqlRow);
  const arrowColumns = getRunSqlColumns(normalizedRows, columns).reduce<Record<string, unknown[]>>((acc, column) => {
    acc[column] = createArrowColumnValues(normalizedRows.map((row) => row[column] ?? null));
    return acc;
  }, {});

  return tableFromArrays(arrowColumns);
}

function createRunSql(rows: Record<string, unknown>[], columns: string[], sourceName?: string | null) {
  return async (sql: string) => {
    const trimmedSql = sql.trim();
    if (!trimmedSql) {
      throw new Error("runSql requires a SQL query.");
    }

    const duckDBService = DuckDBService.getInstance();
    await duckDBService.init();
    const db = duckDBService.getDb();
    if (!db) {
      throw new Error("DuckDB not initialized.");
    }

    const tempTableName = `lens_widget_${Date.now()}_${crypto.randomUUID().replace(/-/g, "_")}`;
    const sourceTableName = sourceName?.trim() || "lens_data";
    const table = createArrowTableFromRows(rows, columns);

    const connection = await db.connect();
    try {
      await connection.insertArrowTable(table, { name: tempTableName });
      await connection.query(
        `CREATE OR REPLACE TEMP VIEW ${quoteIdentifier(sourceTableName)} AS SELECT * FROM ${quoteIdentifier(
          tempTableName
        )}`
      );
      const result = await connection.query(trimmedSql);
      return result.toArray().map((row: any) => normalizeSqlRow(row.toJSON()));
    } finally {
      try {
        await connection.query(`DROP VIEW IF EXISTS ${quoteIdentifier(sourceTableName)}`);
        await connection.query(`DROP TABLE IF EXISTS ${quoteIdentifier(tempTableName)}`);
      } catch {
        // Best-effort cleanup only.
      }
      await connection.close();
    }
  };
}

async function renderGeneratedWidgetForValidation(
  Component: React.ComponentType<GeneratedChartWidgetProps>,
  props: GeneratedChartWidgetProps
) {
  if (typeof document === "undefined" || !document.body) {
    return;
  }

  const [{ createRoot }, { flushSync }] = await Promise.all([import("react-dom/client"), import("react-dom")]);
  const container = document.createElement("div");
  container.style.position = "fixed";
  container.style.left = "-10000px";
  container.style.top = "0";
  container.style.width = `${props.width}px`;
  container.style.height = `${props.height}px`;
  container.style.overflow = "hidden";
  container.style.pointerEvents = "none";
  document.body.appendChild(container);

  let renderError: string | null = null;
  const root = createRoot(container, {
    onCaughtError: (error: unknown) => {
      renderError = getGeneratedWidgetErrorMessage(error, "Generated Lens render failed.");
    },
    onUncaughtError: (error: unknown) => {
      renderError = getGeneratedWidgetErrorMessage(error, "Generated Lens render failed.");
    },
  } as any);

  try {
    flushSync(() => {
      root.render(
        <GeneratedWidgetErrorBoundary
          onError={(errorMessage) => {
            renderError = errorMessage || "Generated Lens render failed.";
          }}
        >
          <Component {...props} />
        </GeneratedWidgetErrorBoundary>
      );
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    if (renderError) {
      throw new Error(renderError);
    }
  } finally {
    try {
      flushSync(() => root.unmount());
    } finally {
      container.remove();
    }
  }
}

export async function validateGeneratedChartWidget(
  input: GeneratedChartWidgetValidationInput
): Promise<GeneratedChartWidgetValidationResult> {
  const libraries = await loadGeneratedWidgetLibraries();
  const { component: Component } = await compileGeneratedWidget(input.code, libraries);
  const rows = input.rows ?? [];
  const columns = input.columns ?? [];
  const columnTypes = input.columnTypes ?? {};
  const baseRunSql = createRunSql(rows, columns, input.sourceName);
  const trimmedDataSql = input.dataSql?.trim();
  const queryRows = trimmedDataSql ? await baseRunSql(trimmedDataSql) : rows;
  const widgetColumns = queryRows.length > 0 ? Object.keys(queryRows[0]) : columns;
  let warning: string | null = null;

  const props: GeneratedChartWidgetProps = {
    rows: queryRows,
    allRows: queryRows,
    columns: widgetColumns,
    columnTypes,
    sourceName: input.sourceName ?? "lens data",
    width: Math.max(1, input.width ?? 672),
    height: Math.max(1, input.height ?? 434),
    performance: {
      rowCount: queryRows.length,
      renderedRowCount: queryRows.length,
      isSampled: input.isSampled ?? false,
      maxDirectRows: queryRows.length,
      maxSvgMarks: MAX_SVG_MARKS,
      maxAnimatedMarks: MAX_ANIMATED_MARKS,
      max3DObjects: MAX_3D_OBJECTS,
    },
    theme,
    viz: getLensVizRuntime(),
    React,
    ReactECharts: ReactEChartsRuntime,
    ECharts,
    Plot: libraries.Plot,
    d3: libraries.d3,
    THREE: libraries.THREE,
    Canvas: libraries.Canvas,
    useFrame: libraries.useFrame,
    OrbitControls: libraries.OrbitControls,
    MapLibre: libraries.MapLibre,
    runSql: baseRunSql,
  };

  await renderGeneratedWidgetForValidation(Component, props);
  return { warning };
}

export const GeneratedChartWidgetView = React.memo(function GeneratedChartWidgetView({
  isSampled = false,
  code,
  dataSql,
  widgetKey,
  rows,
  columns,
  columnTypes,
  sourceName,
  width,
  height,
  onError,
  onDataSqlError,
}: GeneratedChartWidgetViewProps) {
  const [libraries, setLibraries] = useState<GeneratedWidgetLibraries | null>(null);
  const [Component, setComponent] = useState<React.ComponentType<GeneratedChartWidgetProps> | null>(null);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [queryRows, setQueryRows] = useState<Record<string, unknown>[]>(rows);
  const [isQuerying, setIsQuerying] = useState(false);
  const onErrorRef = useRef(onError);
  const onDataSqlErrorRef = useRef(onDataSqlError);
  const baseRunSql = useMemo(() => createRunSql(rows, columns, sourceName), [columns, rows, sourceName]);
  const widgetColumns = useMemo(
    () => (queryRows.length > 0 ? Object.keys(queryRows[0]) : columns),
    [columns, queryRows]
  );
  const performance = useMemo(
    () => ({
      rowCount: queryRows.length,
      renderedRowCount: queryRows.length,
      isSampled,
      maxDirectRows: queryRows.length,
      maxSvgMarks: MAX_SVG_MARKS,
      maxAnimatedMarks: MAX_ANIMATED_MARKS,
      max3DObjects: MAX_3D_OBJECTS,
    }),
    [queryRows.length, isSampled]
  );
  const runSql = baseRunSql;

  useEffect(() => {
    onErrorRef.current = onError;
    onDataSqlErrorRef.current = onDataSqlError;
  }, [onError, onDataSqlError]);

  useEffect(() => {
    let cancelled = false;
    const trimmedDataSql = dataSql?.trim();
    setDataError(null);

    if (!trimmedDataSql) {
      setIsQuerying(false);
      setQueryRows(rows);
      return () => {
        cancelled = true;
      };
    }

    setIsQuerying(true);
    baseRunSql(trimmedDataSql)
      .then((nextRows) => {
        if (cancelled) return;
        setQueryRows(nextRows);
        setIsQuerying(false);
      })
      .catch((nextError: any) => {
        if (cancelled) return;
        console.error("Generated Lens data SQL failed", nextError);
        const errorMessage = nextError?.message || "Generated Lens data SQL failed.";
        setDataError(errorMessage);
        setIsQuerying(false);
        onDataSqlErrorRef.current?.(errorMessage);
      });

    return () => {
      cancelled = true;
    };
  }, [baseRunSql, dataSql, rows]);

  useEffect(() => {
    let cancelled = false;
    setCompileError(null);
    setComponent(null);

    loadGeneratedWidgetLibraries()
      .then(async (loadedLibraries) => {
        const { component: compiledComponent } = await compileGeneratedWidget(code, loadedLibraries);
        return { loadedLibraries, compiledComponent };
      })
      .then(({ loadedLibraries, compiledComponent }) => {
        if (cancelled) return;
        setLibraries(loadedLibraries);
        setComponent(() => compiledComponent);
      })
      .catch((nextError: any) => {
        if (cancelled) return;
        console.error("Generated Lens failed", nextError);
        const errorMessage = nextError?.message || "Generated Lens failed.";
        setCompileError(errorMessage);
        onErrorRef.current?.(errorMessage);
      });

    return () => {
      cancelled = true;
    };
  }, [code]);

  if (compileError || dataError) {
    return <GeneratedWidgetErrorPanel />;
  }

  if (!libraries || !Component || isQuerying) {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontWeight: 900,
          color: "#111827",
        }}
      >
        {isQuerying ? "Running Lens SQL..." : "Loading Lens..."}
      </div>
    );
  }

  return (
    <GeneratedWidgetErrorBoundary key={`${widgetKey}:${code}`} onError={onError}>
      <Component
        rows={queryRows}
        allRows={queryRows}
        columns={widgetColumns}
        columnTypes={columnTypes}
        sourceName={sourceName}
        width={width}
        height={height}
        performance={performance}
        theme={theme}
        viz={getLensVizRuntime()}
        React={React}
        ReactECharts={ReactEChartsRuntime}
        ECharts={ECharts}
        Plot={libraries.Plot}
        d3={libraries.d3}
        THREE={libraries.THREE}
        Canvas={libraries.Canvas}
        useFrame={libraries.useFrame}
        OrbitControls={libraries.OrbitControls}
        MapLibre={libraries.MapLibre}
        runSql={runSql}
      />
    </GeneratedWidgetErrorBoundary>
  );
});
