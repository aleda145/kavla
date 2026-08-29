import type { Editor, TLAssetPartial, TLCamera } from "tldraw";
import { CameraRecordType, parseTldrawJsonFile } from "tldraw";
import type { DataSourceShape } from "../../DataSource/data-source-types";
import type { SQLTextAreaShape } from "../../SQLTextArea/sql-text-area-types";

export type KavlaBlobKind = "source" | "asset";

export interface KavlaBlobDescriptor {
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
};

export class KavlaSaveConflictError extends Error {}

let activeSession: KavlaLocalSession | null = null;
let canvasStageQueue: Promise<void> = Promise.resolve();

function readCameraRecords(canvasJson: string | null): TLCamera[] {
  if (!canvasJson) return [];
  return (JSON.parse(canvasJson) as { records: unknown[] }).records.flatMap((record) => {
    if (typeof record !== "object" || record === null || !("typeName" in record) || record.typeName !== "camera") {
      return [];
    }
    return [CameraRecordType.validator.validate(record)];
  });
}

function updateDocumentTitle(documentName: string): void {
  const canvasName = documentName.trim().replace(/\.kavla$/i, "") || "Untitled";
  document.title = `Kavla - ${canvasName}`;
}

export function getActiveLocalSession(): KavlaLocalSession | null {
  return activeSession;
}

export function getSessionBlob(kind: KavlaBlobKind, shapeId: string): KavlaBlobDescriptor | null {
  return activeSession?.blobs.find((blob) => blob.kind === kind && blob.shapeId === shapeId) ?? null;
}

export function getSessionBlobUrl(blobId: string): string {
  const url = new URL(`/api/session/blobs/${encodeURIComponent(blobId)}`, window.location.origin);
  const descriptor = activeSession?.blobs.find((blob) => blob.id === blobId);
  if (descriptor) {
    url.searchParams.set("v", descriptor.sha256);
  }
  return url.toString();
}

export async function discoverLocalSession(): Promise<KavlaLocalSession | null> {
  const response = await fetch("/api/session", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  const contentType = response.headers.get("Content-Type") ?? "";
  if (response.status === 404 || contentType.includes("text/html")) {
    activeSession = null;
    return null;
  }
  if (!response.ok) {
    throw new Error(`Local Kavla session failed with status ${response.status}`);
  }

  const session = (await response.json()) as KavlaLocalSession;
  if (
    !session.documentId ||
    !session.documentName ||
    typeof session.fileSize !== "number" ||
    !Array.isArray(session.blobs)
  ) {
    throw new Error("Local Kavla session returned an invalid document description");
  }
  activeSession = session;
  updateDocumentTitle(session.documentName);
  return session;
}

export function loadCanvasJson(editor: Editor, canvasJson: string): void {
  const parsed = parseTldrawJsonFile({
    json: canvasJson,
    schema: editor.store.schema,
  });
  if (!parsed.ok) {
    throw new Error(`Could not load canvas: ${parsed.error.type}`);
  }

  editor.loadSnapshot(parsed.value.getStoreSnapshot());
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
          props: { isRunning: false, queryStartTime: null, runnerName: null },
        },
      ];
    }
    return [];
  });
  if (interruptedShapes.length > 0) {
    editor.updateShapes(interruptedShapes);
  }
  editor.clearHistory();
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
  const operation = canvasStageQueue.then(async () => {
    if (!activeSession) return;

    const canvasJson = serializeLocalCanvasJson(editor, includeCurrentCamera);
    if (canvasJson === activeSession.canvasJson) return;
    const response = await fetch("/api/session/document", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: canvasJson,
    });
    if (!response.ok) {
      throw new Error(`Could not stage canvas (status ${response.status})`);
    }
    activeSession.canvasJson = canvasJson;
  });
  canvasStageQueue = operation.catch(() => undefined);
  return operation;
}

export async function saveLocalSession(): Promise<SaveLocalSessionResult | null> {
  if (!activeSession) return null;

  const response = await fetch("/api/session/save", {
    method: "POST",
    credentials: "same-origin",
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Could not save .kavla file (status ${response.status})`);
  }
  const result = (await response.json()) as SaveLocalSessionResult;
  activeSession.documentName = result.documentName;
  activeSession.fileSize = result.fileSize;
  updateDocumentTitle(result.documentName);
  return result;
}

export async function listLocalSessionDirectory(path?: string): Promise<KavlaDirectoryListing> {
  if (!activeSession) {
    throw new Error("Open Kavla through the CLI to choose a save location");
  }
  const params = path ? `?${new URLSearchParams({ path }).toString()}` : "";
  const response = await fetch(`/api/session/directories${params}`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Could not list save directory (status ${response.status})`);
  }
  return (await response.json()) as KavlaDirectoryListing;
}

export async function saveLocalSessionAs(options: SaveLocalSessionOptions): Promise<SaveLocalSessionResult> {
  if (!activeSession) {
    throw new Error("Open Kavla through the CLI to save .kavla documents");
  }
  const response = await fetch("/api/session/save-as", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  if (response.status === 409) {
    throw new KavlaSaveConflictError((await response.text()) || "The selected Kavla document already exists");
  }
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Could not save .kavla file (status ${response.status})`);
  }
  const result = (await response.json()) as SaveLocalSessionResult;
  activeSession.documentName = result.documentName;
  activeSession.fileSize = result.fileSize;
  updateDocumentTitle(result.documentName);
  return result;
}

export async function loadLocalSessionPath(path: string): Promise<void> {
  if (!activeSession) {
    throw new Error("Open Kavla through the CLI to load .kavla documents");
  }
  const response = await fetch("/api/session/load-path", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Could not load .kavla file (status ${response.status})`);
  }
}

export async function newLocalSession(
  options: SaveLocalSessionOptions,
  canvasJson: string
): Promise<SaveLocalSessionResult> {
  if (!activeSession) {
    throw new Error("Open Kavla through the CLI to create .kavla documents");
  }
  const response = await fetch("/api/session/new", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...options, canvasJson }),
  });
  if (response.status === 409) {
    throw new KavlaSaveConflictError((await response.text()) || "The selected Kavla document already exists");
  }
  if (!response.ok) {
    const message = await response.text();
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
  const response = await fetch(`/api/session/blobs/${encodeURIComponent(options.id)}?${params.toString()}`, {
    method: "PUT",
    credentials: "same-origin",
    body: options.file,
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Could not stage ${options.kind} data (status ${response.status})`);
  }

  const descriptor = (await response.json()) as KavlaBlobDescriptor;
  if (!activeSession) return;
  activeSession.blobs = [...activeSession.blobs.filter((blob) => blob.id !== descriptor.id), descriptor];
}

export async function downloadSessionBlob(blobId: string): Promise<File> {
  if (!activeSession) {
    throw new Error("No Kavla CLI session is active");
  }

  const descriptor = activeSession.blobs.find((blob) => blob.id === blobId);
  if (!descriptor) {
    throw new Error(`Bundle is missing blob ${blobId}`);
  }

  const response = await fetch(getSessionBlobUrl(blobId), {
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error(`Could not read bundled file ${descriptor.fileName} (status ${response.status})`);
  }

  return new File([await response.blob()], descriptor.fileName, {
    type: descriptor.mimeType || "application/octet-stream",
  });
}

export async function closeLocalSession(): Promise<void> {
  if (!activeSession) return;
  await fetch("/api/session/close", {
    method: "POST",
    credentials: "same-origin",
    keepalive: true,
  });
}
