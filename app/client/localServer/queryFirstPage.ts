import { tableFromIPC } from "apache-arrow";
import { atom } from "tldraw";
import type { QueryScan } from "./types";

interface QueryMetadata {
  rowCount: number;
  schema: { name: string; type: string }[];
  scan?: QueryScan;
}

interface FirstPage {
  rows: Record<string, unknown>[];
  schema: QueryMetadata["schema"];
  total: number | null;
}

export const queryFirstPages = atom("query first pages", new Map<string, FirstPage>());

export function setQueryFirstPage(id: string, page?: FirstPage) {
  const pages = new Map(queryFirstPages.get());
  if (page) pages.set(id, page);
  else pages.delete(id);
  queryFirstPages.set(pages);
}

window.addEventListener("kavla:backend-reset", () => queryFirstPages.set(new Map()));

export async function readPagedQuery(response: Response, onPage: (page: FirstPage) => void): Promise<QueryMetadata> {
  if (!response.headers.get("Content-Type")?.includes("application/x-ndjson")) return response.json();
  if (!response.body) throw new Error("Missing query response.");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error("Query response ended before the metadata arrived.");
      pending += value;
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const frame = JSON.parse(pending.slice(0, newline)) as
          QueryMetadata | { schema: QueryMetadata["schema"]; arrow: string } | { error: string };
        pending = pending.slice(newline + 1);
        if ("error" in frame) throw new Error(frame.error);
        if ("rowCount" in frame) return frame;
        const binary = atob(frame.arrow);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const table = tableFromIPC(bytes);
        onPage({ rows: table.toArray().map((row) => row.toJSON()), schema: frame.schema, total: null });
      }
    }
  } finally {
    await reader.cancel();
  }
}
