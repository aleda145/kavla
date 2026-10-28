import { atom } from "tldraw";
import type { DbtProject, DbtIssue } from "./dbtTypes";

export const dbtState = atom<{
  project: DbtProject | null;
  error: string;
  busy: boolean;
  paused: boolean;
  lastSync: number | null;
  issues: Record<string, DbtIssue>;
}>("dbt sync", { project: null, error: "", busy: false, paused: false, lastSync: null, issues: {} });
