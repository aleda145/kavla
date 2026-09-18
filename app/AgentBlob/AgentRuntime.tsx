import { useCallback, useEffect, useRef } from "react";
import { useEditor, type TLShapeId } from "tldraw";
import { useData } from "../client/useLocalServer";
import { agentClientId, agentRequest, cancelAgentRun, createAgentToolEnvironment, getAgentRuns, isAgentRunActive, useAgentRuns } from "../client/localServer/agentRuns";
import { stageCanvas } from "../client/local/localSession";
import { ensureAgentFinalQueryTable, executeAgentCanvasTool } from "./agentCanvasTools";
import { appendAgentChatEntry, createOrFocusAgentChat, getAgentChat, updateAgentChat } from "./agent-chat-store";
import { getShapeCitations, isContextShape } from "./agent-shape-references";
import type { LensShape } from "../Lens/lens-shape-types";
import { registerAgentQueryReflow } from "./agentLayout";
import { AGENT_BLOB_SHAPE_ID, getAgentBlob, moveAgentBlobToShape, removeAgentBlob, setAgentBlobStatus, startAgentBlob } from "./agent-blob-store";

export function AgentRuntime() {
  const editor = useEditor();
  const data = useData();
  const runs = useAgentRuns();
  const controllers = useRef(new Map<string, AbortController>());
  const handled = useRef(new Set<string>());
  const observedActiveRuns = useRef(new Set<string>());
  const blobRunId = useRef<string | null>(null);
  useEffect(() => registerAgentQueryReflow(editor), [editor]);
  const onActivityShape = useCallback((shapeId: string) => {
    const run = getAgentRuns().find(isAgentRunActive);
    if (!run || shapeId === AGENT_BLOB_SHAPE_ID) return;
    editor.run(() => {
      moveAgentBlobToShape(editor, shapeId as TLShapeId, run.id, run.activity, { status: "working" });
    }, { history: "ignore" });
  }, [editor]);

  useEffect(() => editor.sideEffects.registerAfterChangeHandler("shape", (previous, next) => {
    if (next.id === AGENT_BLOB_SHAPE_ID) return;
    const blob = getAgentBlob(editor);
    if (!blob?.props.targetShapeIds?.includes(next.id)) return;
    const previousSize = previous.props as { w?: number; h?: number };
    const nextSize = next.props as { w?: number; h?: number };
    if (previous.x === next.x && previous.y === next.y && previous.rotation === next.rotation && previous.parentId === next.parentId && previousSize.w === nextSize.w && previousSize.h === nextSize.h) return;
    editor.run(() => {
      moveAgentBlobToShape(editor, next.id, blob.props.currentJobId, blob.props.lastMessage, { status: blob.props.status });
    }, { history: "ignore" });
  }), [editor]);

  useEffect(() => {
    const stop = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      controllers.current.get(id)?.abort();
    };
    window.addEventListener("kavla:cancel-agent-run", stop);
    return () => {
      window.removeEventListener("kavla:cancel-agent-run", stop);
      controllers.current.forEach((controller) => controller.abort());
      controllers.current.clear();
    };
  }, []);

  useEffect(() => {
    const active = runs.find(isAgentRunActive);
    if (active?.clientId === agentClientId) observedActiveRuns.current.add(active.id);
    for (const [id, controller] of controllers.current) {
      if (active?.id !== id) { controller.abort(); controllers.current.delete(id); }
    }
    if (!runs.length) return;
    if (!getAgentChat(editor)) createOrFocusAgentChat(editor);
    const appendOnce = (runId: string, toolCallId: string | undefined, entry: Parameters<typeof appendAgentChatEntry>[1]) => {
      if (getAgentChat(editor)?.props.entries.some((item) => item.runId === runId && item.toolCallId === toolCallId && item.role === entry.role)) return;
      appendAgentChatEntry(editor, { ...entry, runId, toolCallId });
    };
    const visibleRuns = runs.filter((run) => run.createdAt > (getAgentChat(editor)?.props.historyClearedAt || 0));
    for (const run of visibleRuns) {
      appendOnce(run.id, undefined, { role: "user", text: run.prompt });
      for (const call of run.tools) {
        if (call.status !== "completed" || !call.success) continue;
        const shapeIds = [call.result?.shapeId, call.result?.linkedTableId].filter((id): id is string => typeof id === "string");
        appendOnce(run.id, call.callId, { role: "event", text: `${call.tool.replace(/_/g, " ")} completed.`, shapeIds });
      }
      if (!isAgentRunActive(run)) {
        // Only finish runs seen live in their owning tab; never modify replayed history.
        if (observedActiveRuns.current.delete(run.id) && run.status === "completed") {
          try {
            if (ensureAgentFinalQueryTable(editor, run)) {
              void stageCanvas(editor).catch((error) => appendOnce(run.id, "final-result-table", { role: "error", text: `Could not save the final result table: ${error instanceof Error ? error.message : String(error)}` }));
            }
          } catch (error) {
            appendOnce(run.id, "final-result-table", { role: "error", text: `Could not show the final result table: ${error instanceof Error ? error.message : String(error)}` });
          }
        }
        for (const shape of editor.getCurrentPageShapes()) {
          if (shape.type !== "lens-shape") continue;
          const lens = shape as LensShape;
          if (lens.props.jobId === run.id && ["generating", "repairing"].includes(lens.props.generationStatus)) {
            editor.updateShape<LensShape>({ id: lens.id, type: "lens-shape", props: { generationStatus: "error", error: run.error || "Lens generation ended before returning code." } });
          }
        }
        const shapeIds = [...new Set([
          ...getShapeCitations(run.text).map((citation) => citation.shapeId),
          ...run.tools.filter((call) => call.success).flatMap((call) => [call.result?.shapeId, call.result?.linkedTableId]).filter((id): id is string => typeof id === "string"),
        ])];
        const summaryCall = [...run.tools].reverse().find((call) => call.success && call.tool === "create_summary");
        const summaryId = summaryCall?.result?.shapeId;
        const summary = typeof summaryId === "string" ? editor.getShape(summaryId as TLShapeId) : undefined;
        const text = run.status === "completed" && summary?.type === "summary-shape" ? `Added the [summary](${summary.id}) to the canvas.` : run.text || "Done.";
        if (run.text || run.status === "completed") appendOnce(run.id, undefined, { role: "assistant", text, shapeIds });
        if (run.status !== "completed") appendOnce(run.id, undefined, { role: run.status === "failed" ? "error" : "event", text: run.error || `Agent ${run.status}.`, shapeIds });
      }
    }
    const latest = active || visibleRuns[visibleRuns.length - 1];
    const agent = getAgentChat(editor)!;
    const next = { isRunning: Boolean(active), streamingText: active?.text || "", activity: active?.activity || null, threadId: latest?.threadId || agent.props.threadId };
    if (Object.entries(next).some(([key, value]) => agent.props[key as keyof typeof next] !== value)) updateAgentChat(editor, next);
    editor.run(() => {
      if (active) {
        if (blobRunId.current !== active.id) {
          blobRunId.current = active.id;
          if (getAgentBlob(editor)?.props.currentJobId !== active.id) {
            startAgentBlob(editor, active.id, editor.getSelectedShapes().find(isContextShape)?.id);
          }
        }
        const blob = getAgentBlob(editor);
        setAgentBlobStatus(editor, blob?.props.targetShapeIds?.length ? "working" : "thinking", active.id, active.activity);
      } else if (latest && getAgentBlob(editor)?.props.currentJobId === latest.id) {
        if (latest.status === "completed") setAgentBlobStatus(editor, "done", latest.id, "Done");
        else removeAgentBlob(editor);
      }
    }, { history: "ignore" });
    if (active) {
      const call = [...active.tools].reverse().find((call) => call.status === "pending" || call.status === "running") || active.tools[active.tools.length - 1];
      const target = call?.result?.shapeId || call?.arguments.shapeId || call?.arguments.sourceShapeId;
      if (typeof target === "string") onActivityShape(target);
    }
  }, [editor, runs, onActivityShape]);

  useEffect(() => {
    const run = runs.find((run) => isAgentRunActive(run) && run.clientId === agentClientId);
    if (!run || run.tools.some((call) => call.status === "running")) return;
    let controller = controllers.current.get(run.id);
    if (!controller) { controller = new AbortController(); controllers.current.set(run.id, controller); }
    const signal = controller.signal;
    for (const call of run.tools.filter((call) => call.status === "pending").slice(0, 1)) {
      const key = `${run.id}:${call.callId}`;
      if (call.status !== "pending" || handled.current.has(key)) continue;
      handled.current.add(key);
      void (async () => {
        const claim = await agentRequest<{ claimed: boolean }>("tool-claims", { runId: run.id, clientId: agentClientId, callId: call.callId }, signal);
        if (!claim.claimed) return;
        let result: Record<string, unknown>;
        try {
          signal.throwIfAborted();
          const target = call.arguments.shapeId || call.arguments.sourceShapeId || call.arguments.anchorShapeId;
          if (typeof target === "string") onActivityShape(target);
          result = await executeAgentCanvasTool(editor, call.tool, call.arguments, onActivityShape, createAgentToolEnvironment(run, signal, data));
        } catch (error) {
          signal.throwIfAborted();
          result = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        signal.throwIfAborted();
        if (typeof result.shapeId === "string") onActivityShape(result.shapeId);
        // Stage created artifacts before committing the tool result to the journal.
        await stageCanvas(editor);
        signal.throwIfAborted();
        const payload = { runId: run.id, clientId: agentClientId, callId: call.callId, success: result.ok !== false, result, error: result.ok === false ? String(result.error || "The canvas tool failed.") : undefined };
        try { await agentRequest("tool-results", payload, signal); }
        catch (error) {
          signal.throwIfAborted();
          if (!getAgentRuns().some((item) => item.id === run.id && isAgentRunActive(item))) return;
          // Only delivery is retried. Canvas mutations are never repeated.
          await agentRequest("tool-results", payload, signal);
        }
      })().catch((error) => {
        if (signal.aborted) return;
        appendAgentChatEntry(editor, { role: "error", runId: run.id, toolCallId: call.callId, text: `Agent tool delivery failed: ${error instanceof Error ? error.message : String(error)}` });
        void cancelAgentRun(run.id).catch((cancelError) => console.error("Could not stop the agent run", cancelError));
      });
    }
  }, [data, editor, runs, onActivityShape]);


  return null;
}
