import { applyCanvasPreferences } from "../canvasPreferences";
import { parseRecoverableCanvas } from "./parseRecoverableCanvas";
import { canvasApiURL, disconnectCanvas } from "../canvasConnection";
import { sessionFetch, setBackendDocument, resetBackendCaches } from "../backendCompute";
import type { LensShape } from "../../Lens/lens-shape-types";
import type { Editor, TLAsset, TLAssetPartial, TLCamera } from "tldraw";
import { CameraRecordType } from "tldraw";
import type { DataSourceShape } from "../../DataSource/data-source-types";
import type { SQLTextAreaShape } from "../../SQLTextArea/sql-text-area-types";
import { getAgentChat, updateAgentChat } from "../../AgentBlob/agent-chat-store";
import { restoreCanvasUndo, serializeCanvasUndo } from "./canvasUndo";

export type KavlaBlobKind = "source" | "asset";

export interface KavlaBlobDescriptor {
  tableName?: string;
  id: string;
  kind: KavlaBlobKind;
  shapeId: string | null;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
}

export interface KavlaLocalSession {
  documentId: string;
  documentName: string;
  fileSize: number;
  canvasJson: string | null;
  undoJson?: string | null;
  blobs: KavlaBlobDescriptor[];
}

export type KavlaDirectoryEntry = {
  name: string;
  path: string;
  type: "directory" | "document";
};

export type KavlaDirectoryListing = {
  path: string;
  parentPath?: string;
  homePath?: string;
  currentDocumentPath: string;
  entries: KavlaDirectoryEntry[];
};

export type SaveLocalSessionOptions = {
  directory: string;
  fileName: string;
  overwrite: boolean;
};

export type SaveLocalSessionResult = {
  path: string;
  documentName: string;
  fileSize: number;
  canvasUrl: string;
};

export class KavlaSaveConflictError extends Error {}

export type CanvasSnapshot = {
  id: string;
  createdAt: string;
  reason: "opened" | "automatic" | "save" | "before-restore";
  size: number;
  shapeCount: number;
};

export type CanvasHistory = { snapshots: CanvasSnapshot[]; limit: number };

export async function listCanvasSnapshots(): Promise<CanvasHistory> {
  const response = await sessionFetch("/api/session/snapshots");
  if (!response.ok) throw new Error((await sessionErrorMessage(response)) || "Could not load canvas history");
  return response.json() as Promise<CanvasHistory>;
}

export async function setCanvasHistoryLimit(limit: number): Promise<CanvasHistory> {
  const response = await sessionFetch("/api/session/snapshots/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ limit }),
  });
  if (!response.ok) throw new Error((await sessionErrorMessage(response)) || "Could not update history limit");
  return response.json() as Promise<CanvasHistory>;
}

export async function restoreLocalSnapshot(id: string): Promise<KavlaLocalSession> {
  const response = await sessionFetch(`/api/session/snapshots/${encodeURIComponent(id)}/restore`, { method: "POST" });
  if (!response.ok) throw new Error((await sessionErrorMessage(response)) || "Could not restore saved document");
  return acceptLocalSession((await response.json()) as KavlaLocalSession);
}

export async function readCanvasSnapshot(id: string): Promise<string> {
  const response = await sessionFetch(`/api/session/snapshots/${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error((await sessionErrorMessage(response)) || "Could not load canvas snapshot");
  return response.text();
}

export async function createCanvasSnapshot(reason: "automatic" | "before-restore"): Promise<SaveLocalSessionResult> {
  const response = await sessionFetch(`/api/session/snapshots?reason=${reason}`, { method: "POST" });
  if (!response.ok) throw new Error((await sessionErrorMessage(response)) || "Could not save canvas snapshot");
  const result = (await response.json()) as SaveLocalSessionResult;
  if (activeSession) {
    activeSession.documentName = result.documentName;
    activeSession.fileSize = result.fileSize;
  }
  return result;
}

async function sessionErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  if (response.headers.get("Content-Type")?.includes("application/json")) {
    const body = JSON.parse(text) as { error?: string };
    return body.error || text;
  }
  return text;
}

let activeSession: KavlaLocalSession | null = null;
let canvasStageQueue: Promise<void> = Promise.resolve();

function readCameraRecords(canvasJson: string | null): TLCamera[] {
  if (!canvasJson) return [];
  return (JSON.parse(canvasJson) as { records: unknown[] }).records.flatMap((record) => {
    if (typeof record !== "object" || record === null || !("typeName" in record) || record.typeName !== "camera") {
      return [];
    }
    try {
      return [CameraRecordType.validator.validate(record)];
    } catch {
      return [];
    } // Invalid camera records are reported and preserved by canvas recovery.
  });
}

function updateDocumentTitle(documentName: string): void {
  const canvasName = documentName.trim().replace(/\.kavla$/i, "") || "Untitled";
  document.title = `Kavla - ${canvasName}`;
}

export function clearLocalSession(): void {
  activeSession = null;
  setBackendDocument(null);
}

export function getActiveLocalSession(): KavlaLocalSession | null {
  return activeSession;
}

export function getSessionBlob(kind: KavlaBlobKind, shapeId: string): KavlaBlobDescriptor | null {
  return activeSession?.blobs.find((blob) => blob.kind === kind && blob.shapeId === shapeId) ?? null;
}

export function getSessionBlobUrl(blobId: string): string {
  const url = new URL(canvasApiURL(`/api/session/blobs/${encodeURIComponent(blobId)}`), window.location.origin);
  const descriptor = activeSession?.blobs.find((blob) => blob.id === blobId);
  if (descriptor) {
    url.searchParams.set("v", descriptor.sha256);
  }
  return url.toString();
}

export async function discoverLocalSession(): Promise<KavlaLocalSession | null> {
  setBackendDocument(null);
  const response = await sessionFetch("/api/session", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  const contentType = response.headers.get("Content-Type") ?? "";
  if (response.status === 404 || contentType.includes("text/html")) {
    throw new Error("This canvas could not be found on the server.");
  }
  if (!response.ok) {
    throw new Error(`Local Kavla session failed with status ${response.status}`);
  }

  return acceptLocalSession((await response.json()) as KavlaLocalSession);
}

function acceptLocalSession(session: KavlaLocalSession): KavlaLocalSession {
  if (
    !session.documentId ||
    !session.documentName ||
    typeof session.fileSize !== "number" ||
    !Array.isArray(session.blobs)
  ) {
    throw new Error("Local Kavla session returned an invalid document description");
  }
  activeSession = activeSession?.documentId === session.documentId ? Object.assign(activeSession, session) : session;
  setBackendDocument(session.documentId);
  resetBackendCaches();
  updateDocumentTitle(session.documentName);
  return activeSession;
}

export function loadCanvasJson(editor: Editor, canvasJson: string, onWarning?: (message: string) => void): void {
  const recovered = parseRecoverableCanvas(editor, canvasJson);
  editor.loadSnapshot(recovered.snapshot);
  // tldraw's file parser drops assets that have no currently visible shape.
  // An undo may still restore a deleted shape that references one of them.
  const savedRecords = (JSON.parse(canvasJson) as { records: unknown[] }).records;
  const savedAssets = savedRecords.flatMap((record) => {
    if (!record || typeof record !== "object" || !("typeName" in record) || record.typeName !== "asset") return [];
    try {
      return [editor.store.schema.types.asset.validate(record) as TLAsset];
    } catch {
      return [];
    }
  });
  editor.store.put(savedAssets.filter((asset) => !editor.store.has(asset.id)));
  applyCanvasPreferences(editor);
  const cameraRecords = readCameraRecords(canvasJson);
  if (cameraRecords.length > 0) {
    const activeCameraIds = new Set(
      Object.values(editor.store.serialize("session"))
        .filter((record): record is TLCamera => record.typeName === "camera")
        .map((record) => record.id)
    );
    editor.store.put(cameraRecords.filter((record) => activeCameraIds.has(record.id)));
  }
  const bundledAssets: TLAssetPartial[] = [];
  for (const asset of editor.getAssets()) {
    if (asset.type === "bookmark") continue;
    const descriptor = activeSession?.blobs.find((blob) => blob.kind === "asset" && blob.shapeId === asset.id);
    if (!descriptor) continue;
    bundledAssets.push({
      id: asset.id,
      type: asset.type,
      props: { src: getSessionBlobUrl(descriptor.id) },
    });
  }
  editor.updateAssets(bundledAssets);
  const interruptedShapes = editor.getCurrentPageShapes().flatMap((shape) => {
    if (shape.type === "data-source" && (shape as DataSourceShape).props.isRunning) {
      return [{ id: shape.id, type: shape.type, props: { isRunning: false } }];
    }
    if (shape.type === "sql-text-area" && (shape as SQLTextAreaShape).props.isRunning) {
      return [
        {
          id: shape.id,
          type: shape.type,
          props: { isRunning: false, isDirty: true, queryStartTime: null, runnerName: null },
        },
      ];
    }
    return [];
  });
  if (interruptedShapes.length > 0) {
    editor.updateShapes(interruptedShapes);
  }
  for (const shape of editor.getCurrentPageShapes()) {
    if (
      shape.type === "lens-shape" &&
      ["generating", "repairing"].includes((shape as LensShape).props.generationStatus)
    ) {
      editor.updateShape<LensShape>({
        id: shape.id,
        type: "lens-shape",
        props: {
          generationStatus: "error",
          error: "Lens generation was interrupted. Ask the Agent to continue or edit the code.",
        },
      });
    }
  }
  if (getAgentChat(editor)?.props.isRunning) {
    updateAgentChat(editor, { isRunning: false, streamingText: "", activity: null });
  }
  editor.clearHistory();
  if (recovered.warnings.length === 0) {
    try {
      restoreCanvasUndo(editor, activeSession?.undoJson ?? canvasJson);
    } catch (error) {
      onWarning?.(error instanceof Error ? error.message : String(error));
    }
  }
  if (recovered.warnings.length)
    onWarning?.(
      `${recovered.warnings.slice(0, 8).join("\n") + (recovered.warnings.length > 8 ? `\n…and ${recovered.warnings.length - 8} more recovery notes.` : "")}\nOriginal incompatible records are kept in document metadata.`
    );
}

export function serializeLocalCanvasJson(editor: Editor, includeCurrentCamera = false): string {
  const cameraRecords = includeCurrentCamera
    ? Object.values(editor.store.serialize("session")).filter((record) => record.typeName === "camera")
    : readCameraRecords(activeSession?.canvasJson ?? null);
  return JSON.stringify({
    tldrawFileFormatVersion: 1,
    schema: editor.store.schema.serialize(),
    records: [...Object.values(editor.store.serialize("document")), ...cameraRecords],
  });
}

export function stageCanvas(editor: Editor, includeCurrentCamera = false): Promise<void> {
  const session = activeSession;
  const operation = canvasStageQueue.then(async () => {
    if (!session || activeSession !== session) return;

    const canvasJson = serializeLocalCanvasJson(editor, includeCurrentCamera);
    if (canvasJson !== session.canvasJson) {
      const response = await sessionFetch("/api/session/document", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: canvasJson,
      });
      if (!response.ok) throw new Error(`Could not stage canvas (status ${response.status})`);
      if (activeSession === session) session.canvasJson = canvasJson;
    }
    const records = Object.values(editor.store.serialize("document"));
    const currentShapeIds = new Set<string>(
      records.filter((record) => record.typeName === "shape").map((record) => record.id)
    );
    const currentAssetIds = new Set<string>(
      records.flatMap((record) =>
        record.typeName === "shape" && "assetId" in record.props && typeof record.props.assetId === "string"
          ? [record.props.assetId]
          : []
      )
    );
    const largeOrphanShapeIds = new Set<string>();
    const largeOrphanAssetIds = new Set<string>();
    for (const blob of session.blobs) {
      if (blob.tableName || blob.size <= 16 * 1024 * 1024 || !blob.shapeId) continue;
      if (blob.kind === "source" && !currentShapeIds.has(blob.shapeId)) largeOrphanShapeIds.add(blob.shapeId);
      if (blob.kind === "asset" && !currentAssetIds.has(blob.shapeId)) largeOrphanAssetIds.add(blob.shapeId);
    }
    const undoJson = JSON.stringify(serializeCanvasUndo(editor, largeOrphanShapeIds, largeOrphanAssetIds));
    if (undoJson !== session.undoJson) {
      const response = await sessionFetch("/api/session/undo", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: undoJson,
      });
      if (!response.ok) throw new Error(`Could not stage undo (status ${response.status})`);
      if (activeSession === session) session.undoJson = undoJson;
    }
  });
  canvasStageQueue = operation.catch(() => undefined);
  return operation;
}

export async function saveLocalSession(): Promise<SaveLocalSessionResult | null> {
  if (!activeSession) return null;

  const response = await sessionFetch("/api/session/save", {
    method: "POST",
    credentials: "same-origin",
  });
  if (!response.ok) {
    const message = await sessionErrorMessage(response);
    throw new Error(message || `Could not save .kavla file (status ${response.status})`);
  }
  const result = (await response.json()) as SaveLocalSessionResult;
  activeSession.documentName = result.documentName;
  activeSession.fileSize = result.fileSize;
  updateDocumentTitle(result.documentName);
  return result;
}

export async function listLocalSessionDirectory(path?: string): Promise<KavlaDirectoryListing> {
  const params = path ? `?${new URLSearchParams({ path }).toString()}` : "";
  const response = await sessionFetch(`/api/session/directories${params}`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    const message = await sessionErrorMessage(response);
    throw new Error(message || `Could not list save directory (status ${response.status})`);
  }
  return (await response.json()) as KavlaDirectoryListing;
}

export async function saveLocalSessionAs(options: SaveLocalSessionOptions): Promise<SaveLocalSessionResult> {
  if (!activeSession) {
    throw new Error("Open Kavla through the CLI to save .kavla documents");
  }
  await canvasStageQueue;
  const response = await sessionFetch("/api/session/save-as", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  if (response.status === 409) {
    throw new KavlaSaveConflictError(
      (await sessionErrorMessage(response)) || "The selected Kavla document already exists"
    );
  }
  if (!response.ok) {
    const message = await sessionErrorMessage(response);
    throw new Error(message || `Could not save .kavla file (status ${response.status})`);
  }
  const result = (await response.json()) as SaveLocalSessionResult;
  activeSession.documentName = result.documentName;
  activeSession.fileSize = result.fileSize;
  updateDocumentTitle(result.documentName);
  if (result.canvasUrl !== window.location.pathname.replace(/\/$/, "")) {
    disconnectCanvas();
    window.location.assign(result.canvasUrl);
  }
  return result;
}

export async function loadLocalSessionPath(path: string): Promise<{ canvasUrl: string }> {
  const response = await sessionFetch("/api/session/load-path", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!response.ok) {
    const message = await sessionErrorMessage(response);
    throw new Error(message || `Could not load .kavla file (status ${response.status})`);
  }
  return (await response.json()) as { canvasUrl: string };
}

export async function newLocalSession(
  options: SaveLocalSessionOptions,
  canvasJson: string
): Promise<SaveLocalSessionResult> {
  const response = await sessionFetch("/api/session/new", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...options, canvasJson }),
  });
  if (response.status === 409) {
    throw new KavlaSaveConflictError(
      (await sessionErrorMessage(response)) || "The selected Kavla document already exists"
    );
  }
  if (!response.ok) {
    const message = await sessionErrorMessage(response);
    throw new Error(message || `Could not create .kavla file (status ${response.status})`);
  }
  return (await response.json()) as SaveLocalSessionResult;
}

export async function stageSessionBlob(options: {
  id: string;
  kind: KavlaBlobKind;
  shapeId: string;
  file: File;
}): Promise<void> {
  if (!activeSession) return;

  const params = new URLSearchParams({
    kind: options.kind,
    shapeId: options.shapeId,
    fileName: options.file.name,
    mimeType: options.file.type || "application/octet-stream",
  });
  const response = await sessionFetch(`/api/session/blobs/${encodeURIComponent(options.id)}?${params.toString()}`, {
    method: "PUT",
    credentials: "same-origin",
    body: options.file,
  });
  if (!response.ok) {
    const message = await sessionErrorMessage(response);
    throw new Error(message || `Could not stage ${options.kind} data (status ${response.status})`);
  }

  const descriptor = (await response.json()) as KavlaBlobDescriptor;
  if (!activeSession) return;
  rememberUploadedBlob(descriptor);
}

export async function deleteSessionBlob(blob: Pick<KavlaBlobDescriptor, "id" | "tableName">): Promise<void> {
  const endpoint = blob.tableName ? "uploads" : "blobs";
  const response = await sessionFetch(`/api/session/${endpoint}/${encodeURIComponent(blob.id)}`, {
    method: "DELETE",
  });
  if (!response.ok && response.status !== 404) {
    throw new Error((await sessionErrorMessage(response)) || `Could not delete asset (status ${response.status})`);
  }
  forgetUploadedBlob(blob.id);
}

export async function downloadSessionBlob(blobId: string): Promise<File> {
  if (!activeSession) {
    throw new Error("No Kavla CLI session is active");
  }

  const descriptor = activeSession.blobs.find((blob) => blob.id === blobId);
  if (!descriptor) {
    throw new Error(`Bundle is missing blob ${blobId}`);
  }

  const response = await sessionFetch(getSessionBlobUrl(blobId), {
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error(`Could not read bundled file ${descriptor.fileName} (status ${response.status})`);
  }

  return new File([await response.blob()], descriptor.fileName, {
    type: descriptor.mimeType || "application/octet-stream",
  });
}

export async function finishEditorTransfer(requestId: string, error?: string): Promise<void> {
  const response = await sessionFetch("/api/session/transfer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, error }),
  });
  if (!response.ok) throw new Error((await sessionErrorMessage(response)) || "Could not save and transfer the canvas");
}

export async function closeLocalSession(): Promise<void> {
  if (!activeSession) return;
  await sessionFetch("/api/session/close", {
    method: "POST",
    credentials: "same-origin",
    keepalive: true,
  });
}

export function rememberUploadedBlob(blob: KavlaBlobDescriptor): void {
  if (!activeSession) throw new Error("The Kavla document is unavailable.");
  activeSession.blobs = [...activeSession.blobs.filter((entry) => entry.id !== blob.id), blob];
  window.dispatchEvent(new Event("kavla:uploads-changed"));
}
export function forgetUploadedBlob(id: string): void {
  if (activeSession) activeSession.blobs = activeSession.blobs.filter((entry) => entry.id !== id);
  window.dispatchEvent(new Event("kavla:uploads-changed"));
}
