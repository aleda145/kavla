import { tableFromIPC } from "apache-arrow";
import { atom } from "tldraw";

export const backendRevision = atom("backendRevision", 0);
export const isBackendComputing = atom("isBackendComputing", false);
let activeOperations = 0;
let documentId: string | null = null;
export function setBackendDocument(id: string | null): void {
  documentId = id;
}
export function sessionFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (documentId) headers.set("X-Kavla-Document-ID", documentId);
  return fetch(path, { credentials: "same-origin", ...init, headers }).catch((error: unknown) => {
    if (error instanceof TypeError)
      throw new Error("Cannot reach the Kavla backend. Reconnect to the CLI or desktop app and try again.");
    throw error;
  });
}
export function resetBackendCaches(): void {
  backendRevision.set(backendRevision.get() + 1);
  window.dispatchEvent(new Event("kavla:backend-reset"));
}

export async function withBackendActivity<T>(operation: () => Promise<T>): Promise<T> {
  activeOperations++;
  isBackendComputing.set(true);
  try {
    return await operation();
  } finally {
    isBackendComputing.set(--activeOperations > 0);
  }
}

export async function backendRequest(path: string, init?: RequestInit): Promise<Response> {
  const response = await sessionFetch(path, init);
  if (!response.ok) {
    const body = await response.text();
    let message = body;
    try {
      message = (JSON.parse(body) as { error?: string }).error || body;
    } catch {
      /* Plain-text API error. */
    }
    throw new Error(message || `Kavla server request failed (${response.status})`);
  }
  return response;
}

export async function computeRows(sql: string, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
  return queryBackendRows("/api/session/compute", { sql }, signal);
}

export async function queryBackendRows(
  path: string,
  body: unknown,
  signal?: AbortSignal
): Promise<Record<string, unknown>[]> {
  return withBackendActivity(async () => {
    const response = await backendRequest(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    return tableFromIPC(new Uint8Array(await response.arrayBuffer()))
      .toArray()
      .map((row) => row.toJSON() as Record<string, unknown>);
  });
}

export async function validateBackendQuery(sql: string): Promise<void> {
  await backendRequest("/api/session/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql }),
  });
}
