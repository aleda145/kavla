import { getAgentRuns, isAgentRunActive, cancelAgentRun } from "../localServer/agentRuns";
import {
  canvasPersistenceKey,
  connectCanvas,
  disconnectCanvas,
  saveAndOpenCanvas,
  getCanvasConnection,
  subscribeRuntimeEvents,
  useCanvasConnection,
} from "../canvasConnection";
import { waitForBackendOperations, hasPendingBackendOperations } from "../backendCompute";
import { LocalSaveDialog } from "./LocalSaveDialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAssetUrlsByImport } from "@tldraw/assets/imports.vite";
import {
  defaultShapeUtils,
  createTLStore,
  DocumentRecordType,
  PageRecordType,
  TLDOCUMENT_ID,
  getIndexAbove,
  Editor,
  getUserPreferences,
  setUserPreferences,
  Tldraw,
  TLUiAssetUrlOverrides,
  useToasts,
} from "tldraw";
import { LensUtil } from "../../Lens/LensUtil";
import { SummaryShapeUtil } from "../../Summary/SummaryShapeUtil";
import { ChartUtil } from "../../Chart/ChartUtil";
import { AgentBlobUtil } from "../../AgentBlob/AgentBlobUtil";
import { AgentChatUtil } from "../../AgentBlob/AgentChatUtil";
import { CLITerminalUtil } from "../../CLITerminal/CLITerminalUtil";
import { DataSourceUtil } from "../../DataSource/DataSourceUtil";
import { SQLResultTableUtil } from "../../SQLResultArea/SQLResultAreaUtil";
import { SQLTextAreaTool } from "../../SQLTextArea/SQLTextAreaTool";
import { SQLTextAreaUtil } from "../../SQLTextArea/SQLTextAreaUtil";
import source from "../../util/source.svg";
import sql from "../../util/sql.svg";
import { SourceTextAreaTool } from "../../DataSource/DataSourceTool";
import { KavlaArrowBindingUtil, KavlaArrowShapeUtil } from "../KavlaArrowShapeUtil";
import { getBookmarkAsset } from "../getBookmarkAsset";
import { enableRightClickDragPan } from "../canvas/enableRightClickDragPan";
import { useCanvasFileDrop } from "../canvas/useCanvasFileDrop";
import { LocalServerProvider, useData } from "../useLocalServer";
import { localUiOverrides, useLocalComponents } from "./localUi";
import {
  closeLocalSession,
  clearLocalSession,
  finishEditorTransfer,
  discoverLocalSession,
  loadCanvasJson,
  loadLocalSessionPath,
  newLocalSession,
  saveLocalSession,
  type SaveLocalSessionOptions,
  type SaveLocalSessionResult,
  stageCanvas,
  type KavlaLocalSession,
} from "./localSession";
import { localAssetStore } from "./localAssetStore";
import { handleLocalShapeDeleted } from "./handleLocalShapeDeleted";
import { getUniqueName } from "../../util/getUniqueName";
import type { SQLTextAreaShape } from "../../SQLTextArea/sql-text-area-types";

const customShapeUtils = [
  SQLTextAreaUtil,
  SQLResultTableUtil,
  DataSourceUtil,
  ChartUtil,
  LensUtil,
  SummaryShapeUtil,
  CLITerminalUtil,
  AgentChatUtil,
  AgentBlobUtil,
  KavlaArrowShapeUtil,
];

const localShapeUtils = [...customShapeUtils, ...defaultShapeUtils.filter((util) => util.type !== "arrow")];
const customTools = [SQLTextAreaTool, SourceTextAreaTool];
const bundledTldrawAssetUrls = getAssetUrlsByImport();
const customAssetUrls: TLUiAssetUrlOverrides = {
  ...bundledTldrawAssetUrls,
  icons: {
    ...bundledTldrawAssetUrls.icons,
    sql,
    source,
  },
};

function createEmptyCanvasJson(): string {
  const store = createTLStore({ shapeUtils: localShapeUtils, bindingUtils: [KavlaArrowBindingUtil] });
  store.put([
    DocumentRecordType.create({ id: TLDOCUMENT_ID }),
    PageRecordType.create({ id: PageRecordType.createId(), name: "Page 1", index: getIndexAbove(null) }),
  ]);
  return JSON.stringify({
    tldrawFileFormatVersion: 1,
    schema: store.schema.serialize(),
    records: Object.values(store.serialize("document")),
  });
}

const CANVAS_STAGE_IDLE_MS = 2_000;
type PendingEditorTransfer = { id: string; cancelled: boolean };

function SessionLifecycle({ session }: { session: KavlaLocalSession | null }) {
  const connection = useCanvasConnection();
  const [isNavigating, setIsNavigating] = useState(false);
  const [isTransferring, setIsTransferring] = useState(false);
  const transferRef = useRef<PendingEditorTransfer | null>(null);
  const [isDocumentDirty, setIsDocumentDirty] = useState(false);
  useEffect(() => {
    const markUploadsDirty = () => {
      documentRevisionRef.current += 1;
      setIsDocumentDirty(true);
    };
    window.addEventListener("kavla:uploads-changed", markUploadsDirty);
    return () => window.removeEventListener("kavla:uploads-changed", markUploadsDirty);
  }, []);

  const [isDocumentSaving, setIsDocumentSaving] = useState(false);
  const [documentFileSize, setDocumentFileSize] = useState<number | null>(session?.fileSize ?? null);
  const editorRef = useRef<Editor | null>(null);
  const rightDragCleanupRef = useRef<(() => void) | null>(null);
  const storeCleanupRef = useRef<(() => void) | null>(null);
  const shapeSideEffectCleanupRef = useRef<(() => void)[]>([]);
  const saveTimerRef = useRef<number | null>(null);
  const loadedRef = useRef(false);
  const loadingDocumentRef = useRef(false);
  const navigationCommittedRef = useRef(false);
  const documentRevisionRef = useRef(0);
  const { addToast } = useToasts();
  const { deleteShapes } = useData();

  useCanvasFileDrop(editorRef, addToast);

  const stageCurrentCanvas = useCallback(
    async (includeCurrentCamera = false) => {
      const editor = editorRef.current;
      if (!editor || !session) return;
      await stageCanvas(editor, includeCurrentCamera);
    },
    [session]
  );

  const saveCurrentSession = useCallback(async () => {
    if (loadingDocumentRef.current) return;
    if (!session) {
      addToast({
        title: "CLI required",
        description: "Run Kavla through the CLI to save .kavla documents.",
        severity: "warning",
      });
      return;
    }
    const revisionBeingSaved = documentRevisionRef.current;
    setIsDocumentSaving(true);
    try {
      await stageCurrentCanvas(true);
      const savedDocument = await saveLocalSession();
      setDocumentFileSize(savedDocument?.fileSize ?? null);
      if (documentRevisionRef.current === revisionBeingSaved) {
        setIsDocumentDirty(false);
      }
      addToast({ title: "Saved", description: session.documentName, severity: "success" });
    } catch (error) {
      addToast({
        title: "Save failed",
        description: error instanceof Error ? error.message : String(error),
        severity: "error",
      });
    } finally {
      setIsDocumentSaving(false);
    }
  }, [addToast, session, stageCurrentCanvas]);

  const prepareCanvasForSave = useCallback(async () => {
    if (loadingDocumentRef.current) throw new Error("A canvas is already being opened.");
    loadingDocumentRef.current = true;
    setIsNavigating(true);
    editorRef.current?.updateInstanceState({ isReadonly: true });
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    await Promise.all(
      getAgentRuns()
        .filter(isAgentRunActive)
        .map((run) => cancelAgentRun(run.id))
    );
    await waitForBackendOperations();
    await stageCurrentCanvas(true);
  }, [stageCurrentCanvas]);

  const prepareNavigation = useCallback(async () => {
    await prepareCanvasForSave();
    await saveLocalSession();
    setIsDocumentDirty(false);
  }, [prepareCanvasForSave]);

  useEffect(() => {
    const resume = (request: PendingEditorTransfer) => {
      request.cancelled = true;
      if (transferRef.current !== request) return;
      transferRef.current = null;
      loadingDocumentRef.current = false;
      setIsNavigating(false);
      setIsTransferring(false);
      setIsDocumentSaving(false);
    };
    const unsubscribe = subscribeRuntimeEvents((event) => {
      if (event.stream !== "editor") return;
      const { requestId } = event.data as { requestId: string };
      if (event.name === "transfer-cancelled") {
        const request = transferRef.current;
        if (request?.id === requestId) resume(request);
        return;
      }
      if (event.name !== "save-request" || transferRef.current) return;
      if (loadingDocumentRef.current) {
        void finishEditorTransfer(requestId, "The other session is opening a canvas. Try again in a moment.").catch(
          (error: unknown) => {
            console.error("Could not decline the canvas transfer", error);
          }
        );
        return;
      }
      const request: PendingEditorTransfer = { id: requestId, cancelled: false };
      transferRef.current = request;
      setIsTransferring(true);
      setIsDocumentSaving(true);
      void (async () => {
        try {
          if (!editorRef.current || !loadedRef.current)
            throw new Error("The canvas is still opening. Try again in a moment.");
          await prepareCanvasForSave();
          if (request.cancelled) return;
          await finishEditorTransfer(request.id);
          if (!request.cancelled) setIsDocumentDirty(false);
          // Stay frozen until the server confirms transfer or cancellation.
        } catch (error) {
          if (request.cancelled) return;
          const message = error instanceof Error ? error.message : String(error);
          addToast({ title: "Could not transfer canvas", description: message, severity: "error" });
          // A lost HTTP response can follow a successful save. Keep editing
          // paused until the server confirms cancellation or ownership changes.
          void finishEditorTransfer(request.id, message).catch((reportError: unknown) => {
            console.error("Could not report the failed canvas transfer", reportError);
          });
        }
      })();
    });
    return () => {
      unsubscribe();
      const request = transferRef.current;
      if (request) request.cancelled = true;
      transferRef.current = null;
    };
  }, [addToast, prepareCanvasForSave]);

  const loadDocument = useCallback(
    async (path: string) => {
      try {
        await prepareNavigation();
        const result = await loadLocalSessionPath(path);
        navigationCommittedRef.current = true;
        disconnectCanvas();
        window.location.assign(result.canvasUrl);
      } catch (error) {
        loadingDocumentRef.current = false;
        setIsNavigating(false);
        throw error;
      }
    },
    [prepareNavigation]
  );

  const newDocument = useCallback(
    async (options: SaveLocalSessionOptions) => {
      try {
        await prepareNavigation();
        const result = await newLocalSession(options, createEmptyCanvasJson());
        navigationCommittedRef.current = true;
        disconnectCanvas();
        window.location.assign(result.canvasUrl);
        return result;
      } catch (error) {
        loadingDocumentRef.current = false;
        setIsNavigating(false);
        throw error;
      }
    },
    [prepareNavigation]
  );

  useEffect(() => {
    if (connection.status === "ready" || !transferRef.current) return;
    transferRef.current.cancelled = true;
    transferRef.current = null;
    loadingDocumentRef.current = false;
    setIsNavigating(false);
    setIsTransferring(false);
    setIsDocumentSaving(false);
  }, [connection.status]);

  useEffect(() => {
    editorRef.current?.updateInstanceState({ isReadonly: isNavigating || connection.status !== "ready" });
    if (connection.status === "ready" && loadedRef.current && !isNavigating) {
      void stageCurrentCanvas().catch((error: unknown) => {
        addToast({
          title: "Could not stage changes",
          description: error instanceof Error ? error.message : String(error),
          severity: "error",
        });
      });
    }
  }, [isNavigating, connection.status, stageCurrentCanvas, addToast]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if ((!isDocumentDirty && !hasPendingBackendOperations()) || navigationCommittedRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [isDocumentDirty]);

  useEffect(() => {
    const handleSave = async (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      await saveCurrentSession();
    };
    window.addEventListener("keydown", handleSave);
    return () => window.removeEventListener("keydown", handleSave);
  }, [saveCurrentSession]);

  useEffect(() => {
    const handlePageHide = () => {
      if (loadingDocumentRef.current) return;
      void stageCurrentCanvas()
        .catch((error) => console.error("Could not stage Kavla canvas before closing", error))
        .then(() => closeLocalSession())
        .catch((error) => console.error("Could not save canvas before closing", error))
        .finally(disconnectCanvas);
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, [stageCurrentCanvas]);

  const onMount = useCallback(
    async (editor: Editor) => {
      editorRef.current = editor;
      editor.updateInstanceState({
        isReadonly: getCanvasConnection().status !== "ready" || loadingDocumentRef.current,
      });
      rightDragCleanupRef.current?.();
      rightDragCleanupRef.current = enableRightClickDragPan(editor);
      editor.registerExternalAssetHandler("url", getBookmarkAsset);

      if (session && !loadedRef.current) {
        loadedRef.current = true;
        if (session.canvasJson) {
          loadCanvasJson(editor, session.canvasJson);
        }
        const isNewDocument = !session.canvasJson;
        try {
          await stageCurrentCanvas();
          if (isNewDocument) {
            const savedDocument = await saveLocalSession();
            setDocumentFileSize(savedDocument?.fileSize ?? null);
          }
        } catch (error) {
          addToast({
            title: "Could not stage changes",
            description: error instanceof Error ? error.message : String(error),
            severity: "error",
          });
        }
      }

      for (const cleanup of shapeSideEffectCleanupRef.current) cleanup();
      shapeSideEffectCleanupRef.current = [
        editor.sideEffects.registerAfterDeleteHandler("shape", (shape) => {
          handleLocalShapeDeleted(editor, shape, deleteShapes);
        }),
        editor.sideEffects.registerBeforeCreateHandler("shape", (shape) => {
          let nextShape = shape;
          if ("name" in nextShape.props && typeof nextShape.props.name === "string") {
            nextShape = {
              ...nextShape,
              props: {
                ...nextShape.props,
                name: getUniqueName(editor, nextShape.props.name),
              },
            };
          }

          if (nextShape.type !== "sql-text-area") {
            return nextShape;
          }

          const sqlProps = nextShape.props as SQLTextAreaShape["props"];
          return {
            ...nextShape,
            props: {
              ...sqlProps,
              linkedTableId: null,
              error: null,
              isRunning: false,
              downstreamShapeIds: null,
              upstreamShapeIds: null,
              stale: false,
            },
          };
        }),
      ];

      storeCleanupRef.current?.();
      const queueCanvasStage = () => {
        if (!session) return;
        documentRevisionRef.current += 1;
        setIsDocumentDirty(true);
        if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = window.setTimeout(() => {
          saveTimerRef.current = null;
          void stageCurrentCanvas().catch((error) => {
            addToast({
              title: "Could not stage changes",
              description: error instanceof Error ? error.message : String(error),
              severity: "error",
            });
          });
        }, CANVAS_STAGE_IDLE_MS);
      };
      const cleanupDocumentListener = editor.store.listen(queueCanvasStage, {
        source: "user",
        scope: "document",
      });
      storeCleanupRef.current = cleanupDocumentListener;
    },
    [addToast, deleteShapes, session, stageCurrentCanvas]
  );

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      storeCleanupRef.current?.();
      rightDragCleanupRef.current?.();
      for (const cleanup of shapeSideEffectCleanupRef.current) cleanup();
      shapeSideEffectCleanupRef.current = [];
    };
  }, []);

  return (
    <>
      <LocalCanvasMount
        documentFileSize={documentFileSize}
        isDocumentDirty={isDocumentDirty}
        isDocumentSaving={isDocumentSaving}
        onLoadDocument={loadDocument}
        onMount={onMount}
        onNewDocument={newDocument}
        onSaveDocument={saveCurrentSession}
        session={session}
      />
      {isTransferring && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-[#f8f7f4]/95 p-8">
          <div className="rounded-xl border-4 border-black bg-blue-100 p-6 font-bold">
            Saving your changes before opening this canvas in another session…
          </div>
        </div>
      )}
    </>
  );
}

function LocalCanvasMount({
  documentFileSize,
  isDocumentDirty,
  isDocumentSaving,
  onLoadDocument,
  onMount,
  onNewDocument,
  onSaveDocument,
  session,
}: {
  documentFileSize: number | null;
  isDocumentDirty: boolean;
  isDocumentSaving: boolean;
  onLoadDocument: (path: string) => Promise<void>;
  onMount: (editor: Editor) => void | Promise<void>;
  onNewDocument: (options: SaveLocalSessionOptions) => Promise<SaveLocalSessionResult>;
  onSaveDocument: () => Promise<void>;
  session: KavlaLocalSession | null;
}) {
  const components = useLocalComponents({
    fileSize: documentFileSize,
    documentName: session?.documentName ?? "Local canvas",
    documentsAvailable: session !== null,
    isDocumentDirty,
    isDocumentSaving,
    onLoadDocument,
    onNewDocument,
    onSaveDocument,
  });
  const bindingUtils = useMemo(() => [KavlaArrowBindingUtil], []);

  return (
    <Tldraw
      persistenceKey={canvasPersistenceKey()}
      onMount={(editor) => void onMount(editor)}
      shapeUtils={localShapeUtils}
      bindingUtils={bindingUtils}
      tools={customTools}
      overrides={localUiOverrides}
      components={components}
      assetUrls={customAssetUrls}
      assets={localAssetStore}
      options={{ actionShortcutsLocation: "menu", maxPages: 1 }}
    />
  );
}

function CanvasUnavailable({
  message,
  canChoose,
  canTransfer = false,
}: {
  message: string;
  canChoose: boolean;
  canTransfer?: boolean;
}) {
  const [mode, setMode] = useState<"load" | "new" | null>(null);
  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-[#f8f7f4]/95 p-8">
      <div className="max-w-xl rounded-xl border-4 border-black bg-yellow-100 p-6 shadow-[6px_6px_0_0_#000]">
        <h1 className="mb-2 text-xl font-black">Canvas unavailable</h1>
        <p className="font-mono text-sm">{message}</p>
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            className="rounded border-2 border-black bg-white px-3 py-1 font-bold"
            onClick={() => window.location.reload()}
          >
            Retry
          </button>
          {canTransfer && (
            <button
              className="rounded border-2 border-black bg-blue-100 px-3 py-1 font-bold"
              onClick={saveAndOpenCanvas}
            >
              Save and open here
            </button>
          )}
          {canChoose && (
            <>
              <button
                className="rounded border-2 border-black bg-green-100 px-3 py-1 font-bold"
                onClick={() => setMode("load")}
              >
                Open
              </button>
              <button
                className="rounded border-2 border-black bg-yellow-200 px-3 py-1 font-bold"
                onClick={() => setMode("new")}
              >
                New
              </button>
            </>
          )}
        </div>
        {canTransfer && (
          <p className="mt-3 text-sm">
            The other session will save its latest changes and uploads before this canvas opens here. If it cannot save
            or respond, it keeps the canvas.
          </p>
        )}
        {mode && (
          <LocalSaveDialog
            documentName="Canvas"
            mode={mode}
            onClose={() => setMode(null)}
            onLoad={async (path) => {
              const result = await loadLocalSessionPath(path);
              disconnectCanvas();
              window.location.assign(result.canvasUrl);
            }}
            onSave={async (options) => {
              const result = await newLocalSession(options, createEmptyCanvasJson());
              disconnectCanvas();
              window.location.assign(result.canvasUrl);
              return result;
            }}
          />
        )}
      </div>
    </div>
  );
}

export default function LocalKavlaApp() {
  const connection = useCanvasConnection();
  const [session, setSession] = useState<KavlaLocalSession | null>(null);
  const [initializationError, setInitializationError] = useState<string | null>(null);

  useEffect(() => {
    const preferences = { ...getUserPreferences(), colorScheme: "light" as const };
    setUserPreferences(preferences);
    connectCanvas();
  }, []);

  useEffect(() => {
    if (connection.status === "transferred") {
      clearLocalSession();
      setSession(null);
    }
  }, [connection.status]);

  useEffect(() => {
    if (connection.status !== "ready" || session) return;
    let cancelled = false;
    discoverLocalSession()
      .then((nextSession) => {
        if (!cancelled) setSession(nextSession);
      })
      .catch((error: unknown) => {
        if (!cancelled) setInitializationError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [connection.status, session]);

  if (initializationError) return <CanvasUnavailable message={initializationError} canChoose />;
  if (!session) {
    if (connection.status === "blocked" || connection.status === "transferred")
      return <CanvasUnavailable message={connection.message} canChoose canTransfer={connection.status === "blocked"} />;
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-[#f8f7f4] font-bold">
        {connection.message || "Opening canvas…"}
      </div>
    );
  }
  return (
    <div className="fixed inset-0">
      <LocalServerProvider>
        <SessionLifecycle session={session} />
      </LocalServerProvider>
      {connection.status !== "ready" && <CanvasUnavailable message={connection.message} canChoose={false} />}
    </div>
  );
}
