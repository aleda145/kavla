import { useEffect, useRef } from "react";
import { useEditor } from "tldraw";
import { useData } from "../client/useLocalServer";
import { codexClientId, codexRequest, cancelCodexRun, createCodexToolEnvironment, getCodexRuns, isCodexRunActive, useCodexRuns } from "../client/localServer/codexRuns";
import { stageCanvas } from "../client/local/localSession";
import { executeCodexCanvasTool } from "./codexCanvasTools";
import { appendCodexAgentEntry, createOrFocusCodexAgent, getCodexAgent, updateCodexAgent } from "./codex-agent-store";
import { getShapeCitations } from "./codex-shape-references";
import type { LensShape } from "../Lens/lens-shape-types";

export function CodexAgentRuntime({ onActivityShape }: { onActivityShape: (shapeId: string) => void }) {
  const editor = useEditor();
  const data = useData();
  const runs = useCodexRuns();
  const controllers = useRef(new Map<string, AbortController>());
  const handled = useRef(new Set<string>());

  useEffect(() => {
    const stop = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      controllers.current.get(id)?.abort();
    };
    window.addEventListener("kavla:cancel-codex-run", stop);
    return () => {
      window.removeEventListener("kavla:cancel-codex-run", stop);
      controllers.current.forEach((controller) => controller.abort());
      controllers.current.clear();
    };
  }, []);

  useEffect(() => {
    const active = runs.find(isCodexRunActive);
    for (const [id, controller] of controllers.current) {
      if (active?.id !== id) { controller.abort(); controllers.current.delete(id); }
    }
    if (!runs.length) return;
    if (!getCodexAgent(editor)) createOrFocusCodexAgent(editor);
    const appendOnce = (runId: string, toolCallId: string | undefined, entry: Parameters<typeof appendCodexAgentEntry>[1]) => {
      if (getCodexAgent(editor)?.props.entries.some((item) => item.runId === runId && item.toolCallId === toolCallId && item.role === entry.role)) return;
      appendCodexAgentEntry(editor, { ...entry, runId, toolCallId });
    };
    const visibleRuns = runs.filter((run) => run.createdAt > (getCodexAgent(editor)?.props.historyClearedAt || 0));
    for (const run of visibleRuns) {
      appendOnce(run.id, undefined, { role: "user", text: run.prompt });
      for (const call of run.tools) {
        if (call.status !== "completed") continue;
        const shapeIds = [call.result?.shapeId, call.result?.linkedTableId].filter((id): id is string => typeof id === "string");
        appendOnce(run.id, call.callId, { role: "event", text: `${call.tool.replace(/_/g, " ")}${call.success ? " completed." : ` needs correction: ${call.error || call.result?.error || "Tool failed."}`}`, shapeIds });
      }
      if (!isCodexRunActive(run)) {
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
        if (run.text || run.status === "completed") appendOnce(run.id, undefined, { role: "assistant", text: run.text || "Done.", shapeIds });
        if (run.status !== "completed") appendOnce(run.id, undefined, { role: run.status === "failed" ? "error" : "event", text: run.error || `Agent ${run.status}.`, shapeIds });
      }
    }
    const latest = active || visibleRuns[visibleRuns.length - 1];
    const agent = getCodexAgent(editor)!;
    const next = { isRunning: Boolean(active), streamingText: active?.text || "", activity: active?.activity || null, codexThreadId: latest?.threadId || agent.props.codexThreadId };
    if (Object.entries(next).some(([key, value]) => agent.props[key as keyof typeof next] !== value)) updateCodexAgent(editor, next);
    if (active) {
      const call = [...active.tools].reverse().find((call) => call.status === "pending" || call.status === "running") || active.tools[active.tools.length - 1];
      const target = call?.result?.shapeId || call?.arguments.shapeId || call?.arguments.sourceShapeId;
      if (typeof target === "string") onActivityShape(target);
    }
  }, [editor, runs, onActivityShape]);

  useEffect(() => {
    const run = runs.find((run) => isCodexRunActive(run) && run.clientId === codexClientId);
    if (!run || run.tools.some((call) => call.status === "running")) return;
    let controller = controllers.current.get(run.id);
    if (!controller) { controller = new AbortController(); controllers.current.set(run.id, controller); }
    const signal = controller.signal;
    for (const call of run.tools.filter((call) => call.status === "pending").slice(0, 1)) {
      const key = `${run.id}:${call.callId}`;
      if (call.status !== "pending" || handled.current.has(key)) continue;
      handled.current.add(key);
      void (async () => {
        const claim = await codexRequest<{ claimed: boolean }>("tool-claims", { runId: run.id, clientId: codexClientId, callId: call.callId }, signal);
        if (!claim.claimed) return;
        let result: Record<string, unknown>;
        try {
          signal.throwIfAborted();
          const target = call.arguments.shapeId || call.arguments.sourceShapeId || call.arguments.anchorShapeId;
          if (typeof target === "string") onActivityShape(target);
          result = await executeCodexCanvasTool(editor, call.tool, call.arguments, onActivityShape, createCodexToolEnvironment(run, signal, data));
        } catch (error) {
          signal.throwIfAborted();
          result = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        signal.throwIfAborted();
        if (typeof result.shapeId === "string") onActivityShape(result.shapeId);
        // Stage created artifacts before committing the tool result to the journal.
        await stageCanvas(editor);
        signal.throwIfAborted();
        const payload = { runId: run.id, clientId: codexClientId, callId: call.callId, success: result.ok !== false, result, error: result.ok === false ? String(result.error || "The canvas tool failed.") : undefined };
        try { await codexRequest("tool-results", payload, signal); }
        catch (error) {
          signal.throwIfAborted();
          if (!getCodexRuns().some((item) => item.id === run.id && isCodexRunActive(item))) return;
          // Only delivery is retried. Canvas mutations are never repeated.
          await codexRequest("tool-results", payload, signal);
        }
      })().catch((error) => {
        if (signal.aborted) return;
        appendCodexAgentEntry(editor, { role: "error", runId: run.id, toolCallId: call.callId, text: `Agent tool delivery failed: ${error instanceof Error ? error.message : String(error)}` });
        void cancelCodexRun(run.id).catch((cancelError) => console.error("Could not stop the agent run", cancelError));
      });
    }
  }, [data, editor, runs, onActivityShape]);


  return null;
}
