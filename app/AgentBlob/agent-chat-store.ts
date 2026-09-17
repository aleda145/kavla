import { createShapeId, type Editor, type TLShapeId } from "tldraw";
import type { AgentChatEntry, AgentChatShape } from "./agent-chat-types";

export const AGENT_CHAT_SHAPE_ID = createShapeId("agent-chat");

export function getAgentChat(editor: Editor): AgentChatShape | null {
  const shape = editor.getShape(AGENT_CHAT_SHAPE_ID);
  return shape?.type === "agent-chat" ? shape as AgentChatShape : null;
}

export function createOrFocusAgentChat(editor: Editor) {
  const existing = getAgentChat(editor);
  if (!existing) {
    editor.createShape<AgentChatShape>({
      id: AGENT_CHAT_SHAPE_ID,
      type: "agent-chat",
      x: 0,
      y: 0,
      props: {
        w: 1,
        h: 1,
        name: "Agent",
        entries: [],
        threadId: null,
        isRunning: false,
        streamingText: "",
        activity: null,
        isOpen: true,
      },
    });
  } else {
    updateAgentChat(editor, { isOpen: true });
  }
}

export function updateAgentChat(editor: Editor, props: Partial<AgentChatShape["props"]>) {
  if (!getAgentChat(editor)) return false;
  editor.updateShape<AgentChatShape>({ id: AGENT_CHAT_SHAPE_ID, type: "agent-chat", props });
  return true;
}

export function appendAgentChatEntry(
  editor: Editor,
  entry: Omit<AgentChatEntry, "id" | "createdAt">,
) {
  const shape = getAgentChat(editor);
  if (!shape) return false;
  const next: AgentChatEntry = {
    ...entry,
    id: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
    createdAt: Date.now(),
  };
  updateAgentChat(editor, { entries: [...shape.props.entries, next] });
  return true;
}

export function getAgentContextShapeIds(editor: Editor): TLShapeId[] {
  const selected = editor.getSelectedShapeIds().filter((id) => id !== AGENT_CHAT_SHAPE_ID && editor.getShape(id)?.type !== "agent-blob");
  if (selected.length > 0) return selected.slice(0, 8);
  const recent = [...new Set((getAgentChat(editor)?.props.entries ?? []).slice(-30).reverse().flatMap((entry) => [...(entry.shapeIds ?? []), ...(entry.contextShapeIds ?? [])]))]
    .filter((id) => Boolean(editor.getShape(id as TLShapeId)));
  if (recent.length) return recent.slice(0, 12) as TLShapeId[];
  return editor.getCurrentPageShapes()
    .filter((shape) => ["data-source", "sql-text-area", "chart-shape", "note", "lens-shape", "summary-shape", "sql-result-table"].includes(shape.type))
    .slice(0, 8)
    .map((shape) => shape.id);
}
