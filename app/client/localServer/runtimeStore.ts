import { Dialect, transpile } from "@polyglot-sql/sdk";
import { useEffect, useState } from "react";
import type { UnsubscribeFn } from "./types";

type CliStatusSubscriber = (connected: boolean) => void;
const cliStatusSubscribers = new Set<CliStatusSubscriber>();
let currentCliStatus = false;

export const subscribeCliStatus = (callback: CliStatusSubscriber): UnsubscribeFn => {
  cliStatusSubscribers.add(callback);
  callback(currentCliStatus);
  return () => cliStatusSubscribers.delete(callback);
};

export const notifyCliStatus = (connected: boolean) => {
  currentCliStatus = connected;
  cliStatusSubscribers.forEach((callback) => callback(connected));
};

export const useCliStatus = () => {
  const [connected, setConnected] = useState(currentCliStatus);
  useEffect(() => subscribeCliStatus(setConnected), []);
  return connected;
};

export interface CliOutputLine {
  line: string;
  timestamp: number;
}

type CliOutputSubscriber = (lines: CliOutputLine[]) => void;
const cliOutputSubscribers = new Set<CliOutputSubscriber>();
let currentCliOutput: CliOutputLine[] = [];
const MAX_CLI_OUTPUT_LINES = 50;

const normalizeCliOutputLine = (entry: CliOutputLine): CliOutputLine | null => {
  const line = entry.line.replace(/[\r\n]+$/, "");
  return line.length > 0 ? { ...entry, line } : null;
};

export const subscribeCliOutput = (callback: CliOutputSubscriber): UnsubscribeFn => {
  cliOutputSubscribers.add(callback);
  callback(currentCliOutput);
  return () => cliOutputSubscribers.delete(callback);
};

export const notifyCliOutputLine = (payload: CliOutputLine) => {
  const normalized = normalizeCliOutputLine(payload);
  if (!normalized) return;
  const last = currentCliOutput[currentCliOutput.length - 1];
  if (last && last.timestamp === normalized.timestamp && last.line === normalized.line) return;
  currentCliOutput = [...currentCliOutput, normalized].slice(-MAX_CLI_OUTPUT_LINES);
  cliOutputSubscribers.forEach((callback) => callback(currentCliOutput));
};

export const notifyCliOutputHistory = (lines: CliOutputLine[]) => {
  currentCliOutput = lines
    .map(normalizeCliOutputLine)
    .filter((line): line is CliOutputLine => line !== null)
    .slice(-MAX_CLI_OUTPUT_LINES);
  cliOutputSubscribers.forEach((callback) => callback(currentCliOutput));
};

export const useCliOutput = () => {
  const [lines, setLines] = useState<CliOutputLine[]>(currentCliOutput);
  useEffect(() => subscribeCliOutput(setLines), []);
  return lines;
};

export interface CliSource {
  name: string;
  type: string;
  available?: boolean;
  error?: string;
}

type CliSourcesSubscriber = (sources: CliSource[]) => void;
const cliSourcesSubscribers = new Set<CliSourcesSubscriber>();
let currentCliSources: CliSource[] = [];

export const getCliSourcesSnapshot = (): readonly CliSource[] => currentCliSources;

const normalizeCliSource = (source: unknown): CliSource | null => {
  if (!source || typeof source !== "object") return null;
  const candidate = source as Record<string, unknown>;
  if (typeof candidate.name !== "string" || typeof candidate.type !== "string") return null;
  return {
    name: candidate.name,
    type: candidate.type,
    available: typeof candidate.available === "boolean" ? candidate.available : true,
    error: typeof candidate.error === "string" && candidate.error.trim() ? candidate.error : undefined,
  };
};

export const notifyCliSources = (sources: unknown[]) => {
  currentCliSources = Array.isArray(sources)
    ? sources.map(normalizeCliSource).filter((source): source is CliSource => source !== null)
    : [];
  cliSourcesSubscribers.forEach((callback) => callback(currentCliSources));
};

export const updateCliSourceStatus = (sourceName: string, patch: Partial<CliSource>) => {
  currentCliSources = currentCliSources.map((source) => {
    if (source.name !== sourceName) return source;
    const next = { ...source, ...patch };
    if (patch.available === true && patch.error === undefined) delete next.error;
    return next;
  });
  cliSourcesSubscribers.forEach((callback) => callback(currentCliSources));
};

export const useCliSources = () => {
  const [sources, setSources] = useState<CliSource[]>(currentCliSources);
  useEffect(() => {
    cliSourcesSubscribers.add(setSources);
    setSources(currentCliSources);
    return () => {
      cliSourcesSubscribers.delete(setSources);
    };
  }, []);
  return sources;
};

export const transpileRemoteSQL = (sql: string, sourceName: string, executionEngine: string): string => {
  if (executionEngine === "bigquery") {
    const result = transpile(sql, Dialect.DuckDB, Dialect.BigQuery);
    const transpiledSql = result.sql?.[0];
    if (!result.success || !transpiledSql) throw new Error(result.error || "Failed to transpile SQL for BigQuery");
    return transpiledSql.replaceAll(`\`${sourceName}\`.`, "");
  }
  if (executionEngine === "postgres") {
    const result = transpile(sql, Dialect.DuckDB, Dialect.PostgreSQL);
    const transpiledSql = result.sql?.[0];
    if (!result.success || !transpiledSql) throw new Error(result.error || "Failed to transpile SQL for Postgres");
    return transpiledSql.replaceAll(`"${sourceName}".`, "");
  }
  return sql;
};
