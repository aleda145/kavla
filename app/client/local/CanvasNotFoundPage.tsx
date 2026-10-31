import { useState } from "react";
import { FilePlus2 } from "lucide-react";
import { SQLResultAreaHeader } from "../../SQLResultArea/SQLResultAreaHeader";
import { CanvasFileTable, type CanvasFileEntry } from "./CanvasFileTable";
import { LocalSaveDialog } from "./LocalSaveDialog";
import { createEmptyCanvasJson } from "./LocalKavlaApp";
import {
  KavlaSaveConflictError,
  type KavlaDirectoryListing,
  type SaveLocalSessionOptions,
  type SaveLocalSessionResult,
} from "./localSession";
import "./CanvasNotFoundPage.css";

export type CanvasNotFoundData = { name: string; entries: CanvasFileEntry[] };

async function responseError(response: Response): Promise<string> {
  const body = await response.text();
  if (response.headers.get("Content-Type")?.includes("application/json")) {
    const parsed = JSON.parse(body) as { error?: string };
    return parsed.error || body;
  }
  return body || `Request failed with status ${response.status}`;
}

async function listCanvasDirectory(path?: string): Promise<KavlaDirectoryListing> {
  const query = path ? `?${new URLSearchParams({ path })}` : "";
  const response = await fetch(`/api/canvases/directories${query}`, { credentials: "same-origin" });
  if (!response.ok) throw new Error(await responseError(response));
  return response.json() as Promise<KavlaDirectoryListing>;
}

async function createCanvas(options: SaveLocalSessionOptions): Promise<SaveLocalSessionResult> {
  const response = await fetch("/api/canvases/new", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...options, canvasJson: createEmptyCanvasJson() }),
  });
  if (response.status === 409) throw new KavlaSaveConflictError(await responseError(response));
  if (!response.ok) throw new Error(await responseError(response));
  const result = (await response.json()) as SaveLocalSessionResult;
  window.location.assign(result.canvasUrl);
  return result;
}

export function CanvasNotFoundPage({ data }: { data: CanvasNotFoundData }) {
  const [showNewDialog, setShowNewDialog] = useState(false);
  return (
    <main className="kavla-canvas-not-found">
      <div className="kavla-canvas-not-found-content">
        <div className="kavla-canvas-not-found-heading">
          <h1>
            <span className="kavla-canvas-not-found-name">{data.name}</span> not found
          </h1>
          <button type="button" className="kavla-canvas-not-found-new" onClick={() => setShowNewDialog(true)}>
            <FilePlus2 size={18} aria-hidden /> New canvas
          </button>
        </div>
        <section className="kavla-canvas-not-found-results" aria-label="Canvases">
          <SQLResultAreaHeader resultName="Canvases" />
          <CanvasFileTable entries={data.entries} />
        </section>
      </div>
      {showNewDialog && (
        <LocalSaveDialog
          documentName="Canvas"
          mode="new"
          suggestedNewName={data.name}
          onClose={() => setShowNewDialog(false)}
          onListDirectory={listCanvasDirectory}
          onSave={createCanvas}
        />
      )}
    </main>
  );
}
