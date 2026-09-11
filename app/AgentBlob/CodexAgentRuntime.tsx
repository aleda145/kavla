import { useEffect, useRef } from "react";
import { useEditor } from "tldraw";
import {
  subscribeCodexEvents,
  subscribeCodexThreads,
  subscribeCodexToolRequests,
  type CodexEvent,
} from "../client/localServer/codexStore";
import { useData } from "../client/useLocalServer";
import { executeCodexCanvasTool } from "./codexCanvasTools";
import { appendCodexAgentEntry, getCodexAgent, updateCodexAgent } from "./codex-agent-store";

function messageFromData(data: Record<string, unknown>, fallback: string): string {
  if (typeof data.message === "string" && data.message.trim()) return data.message;
  const error = data.error;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const nested = (error as Record<string, unknown>).message;
    if (typeof nested === "string" && nested.trim()) return nested;
  }
  return fallback;
}

function toolLabel(data: Record<string, unknown>): string {
  const item = data.item && typeof data.item === "object" ? (data.item as Record<string, unknown>) : {};
  const tool = typeof item.tool === "string" ? item.tool : "canvas tool";
  return tool.replace(/_/g, " ");
}

export function CodexAgentRuntime() {
  const editor = useEditor();
  const dataSocket = useData();
  const handledToolCalls = useRef(new Set<string>());
  const completedTurns = useRef(new Set<string>());

  useEffect(() => {
    const shape = getCodexAgent(editor);
    if (shape?.props.isRunning) {
      updateCodexAgent(editor, { isRunning: false, streamingText: "", activity: null });
      appendCodexAgentEntry(editor, {
        role: "event",
        text: "The previous agent turn was interrupted when this canvas closed.",
      });
    }
  }, [editor]);

  useEffect(
    () =>
      subscribeCodexThreads(({ threadId }) => {
        updateCodexAgent(editor, { codexThreadId: threadId });
      }),
    [editor]
  );

  useEffect(
    () =>
      subscribeCodexEvents((event: CodexEvent) => {
        const shape = getCodexAgent(editor);
        if (!shape) return;
        switch (event.eventType) {
          case "layout_started":
            updateCodexAgent(editor, { isRunning: true, activity: "Planning the canvas layout…" });
            return;
          case "started":
            updateCodexAgent(editor, { isRunning: true, activity: "Thinking…" });
            return;
          case "message_delta": {
            const delta = typeof event.data.delta === "string" ? event.data.delta : "";
            if (delta) updateCodexAgent(editor, { streamingText: `${shape.props.streamingText}${delta}` });
            return;
          }
          case "tool_started":
            updateCodexAgent(editor, { activity: `Using ${toolLabel(event.data)}…` });
            return;
          case "tool_finished":
            updateCodexAgent(editor, { activity: "Thinking…" });
            return;
          case "completed": {
            if (!shape.props.isRunning) return;
            const turn =
              event.data.turn && typeof event.data.turn === "object"
                ? (event.data.turn as Record<string, unknown>)
                : {};
            const turnId = typeof turn.id === "string" ? turn.id : "";
            if (turnId && completedTurns.current.has(turnId)) return;
            if (turnId) completedTurns.current.add(turnId);
            const latest = getCodexAgent(editor);
            const text = latest?.props.streamingText.trim() || "Done.";
            appendCodexAgentEntry(editor, { role: "assistant", text });
            updateCodexAgent(editor, { isRunning: false, streamingText: "", activity: null });
            return;
          }
          case "cancelled":
            appendCodexAgentEntry(editor, {
              role: "event",
              text: messageFromData(event.data, "Agent stopped."),
            });
            updateCodexAgent(editor, { isRunning: false, streamingText: "", activity: null });
            return;
          case "error":
            appendCodexAgentEntry(editor, {
              role: "error",
              text: messageFromData(event.data, "The Kavla Agent failed."),
            });
            updateCodexAgent(editor, { isRunning: false, streamingText: "", activity: null });
            return;
          case "warning":
            appendCodexAgentEntry(editor, {
              role: "event",
              text: messageFromData(event.data, "Codex reported a warning."),
            });
            return;
        }
      }),
    [editor]
  );

  useEffect(
    () =>
      subscribeCodexToolRequests((request) => {
        if (handledToolCalls.current.has(request.callId)) return;
        handledToolCalls.current.add(request.callId);
        const run = async () => {
          const agent = getCodexAgent(editor);
          if (!agent?.props.isRunning) throw new Error("The Kavla Agent turn is no longer active.");
          if (agent.props.codexThreadId !== request.threadId) {
            throw new Error("This tool call belongs to a different Kavla conversation.");
          }
          const result = await executeCodexCanvasTool(editor, request.tool, request.arguments);
          dataSocket.sendCodexToolResult({ callId: request.callId, success: true, result });
          const shapeIds = [result.shapeId, result.linkedTableId].filter(
            (id): id is string => typeof id === "string" && Boolean(id)
          );
          if (shapeIds.length > 0) {
            appendCodexAgentEntry(editor, {
              role: "event",
              text:
                result.ok === false
                  ? `${request.tool.replace(/_/g, " ")} needs correction.`
                  : `${request.tool.replace(/_/g, " ")} completed.`,
              shapeIds,
            });
          }
        };
        void run()
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            dataSocket.sendCodexToolResult({ callId: request.callId, success: false, error: message });
          })
          .finally(() => handledToolCalls.current.delete(request.callId));
      }),
    [dataSocket, editor]
  );

  return null;
}
