export type CliSourceConnectionKind = "path_file" | "path_directory" | "text";

export interface CliSourceDefinition {
  type: string;
  label: string;
  connectionLabel: string;
  connectionHelp: string;
  connectionKind: CliSourceConnectionKind;
}

export interface CliConfiguredSource {
  name: string;
  type: string;
  connection: string;
  available: boolean;
  error?: string;
}

export interface CliSourcesConfiguration {
  configPath: string;
  definitions: CliSourceDefinition[];
  sources: CliConfiguredSource[];
}

export interface CliSourceInput {
  name: string;
  type: string;
  connection: string;
}

export interface CliSourcePathEntry {
  name: string;
  path: string;
  type: "directory" | "file";
}

export interface CliSourcePathListing {
  path: string;
  parentPath?: string;
  homePath?: string;
  entries: CliSourcePathEntry[];
}

async function readResponseError(response: Response): Promise<Error> {
  const message = (await response.text()).trim();
  return new Error(message || `Kavla CLI request failed with status ${response.status}`);
}

export async function loadCliSources(): Promise<CliSourcesConfiguration> {
  const response = await fetch("/api/cli/sources", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw await readResponseError(response);
  return (await response.json()) as CliSourcesConfiguration;
}

export async function createCliSource(input: CliSourceInput): Promise<CliSourcesConfiguration> {
  const response = await fetch("/api/cli/sources", {
    method: "POST",
    credentials: "same-origin",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await readResponseError(response);
  return (await response.json()) as CliSourcesConfiguration;
}

export async function updateCliSource(originalName: string, input: CliSourceInput): Promise<CliSourcesConfiguration> {
  const response = await fetch(`/api/cli/sources/${encodeURIComponent(originalName)}`, {
    method: "PUT",
    credentials: "same-origin",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await readResponseError(response);
  return (await response.json()) as CliSourcesConfiguration;
}

export async function deleteCliSource(name: string): Promise<CliSourcesConfiguration> {
  const response = await fetch(`/api/cli/sources/${encodeURIComponent(name)}`, {
    method: "DELETE",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw await readResponseError(response);
  return (await response.json()) as CliSourcesConfiguration;
}

export async function listCliSourcePath(path?: string): Promise<CliSourcePathListing> {
  const query = path ? `?${new URLSearchParams({ path }).toString()}` : "";
  const response = await fetch(`/api/cli/source-paths${query}`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw await readResponseError(response);
  return (await response.json()) as CliSourcePathListing;
}
