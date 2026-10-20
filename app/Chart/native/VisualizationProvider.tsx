import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useValue } from "tldraw";
import { backendRequest, backendRevision, withBackendActivity } from "../../client/backendCompute";
import { editorToken, useCanvasConnection } from "../../client/canvasConnection";
import { SQL_SHAPE_RUN_FINISHED_EVENT } from "../../SQLTextArea/sqlShapeRun";
import { createVisualizationSession } from "./coordinator";

export const VisualizationContext = createContext<ReturnType<typeof createVisualizationSession> | null>(null);

export function VisualizationProvider({ children, documentId }: { children: ReactNode; documentId: string | null }) {
  const revision = useValue("visualization backend revision", () => backendRevision.get(), []);
  const connection = useCanvasConnection();
  const token = editorToken();
  const [runs, setRuns] = useState(0);
  useEffect(() => {
    const invalidate = () => setRuns((n) => n + 1);
    window.addEventListener(SQL_SHAPE_RUN_FINISHED_EVENT, invalidate);
    return () => window.removeEventListener(SQL_SHAPE_RUN_FINISHED_EVENT, invalidate);
  }, []);
  const session = useMemo(
    () => ({
      mounts: 0,
      ...createVisualizationSession((sql, signal) =>
        withBackendActivity(async () => {
          const response = await backendRequest("/api/session/compute", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/vnd.apache.arrow.stream" },
            body: JSON.stringify({ sql }),
            signal,
          });
          if (!response.headers.get("Content-Type")?.includes("application/vnd.apache.arrow"))
            throw new Error(
              "Visualization compute must return Arrow IPC. A Parquet or truncated result cannot be used."
            );
          return new Uint8Array(await response.arrayBuffer());
        })
      ),
    }),
    [documentId, revision, connection.status, token, runs]
  );
  useEffect(() => {
    session.mounts++;
    return () => {
      session.mounts--;
      // React StrictMode immediately reacquires the same resource.
      queueMicrotask(() => {
        if (!session.mounts) session.dispose();
      });
    };
  }, [session]);
  return <VisualizationContext.Provider value={session}>{children}</VisualizationContext.Provider>;
}

export function useVisualizationSession() {
  const session = useContext(VisualizationContext);
  if (!session) throw new Error("A document-scoped visualization session is required.");
  return session;
}
