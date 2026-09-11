import { createShapeId, type Editor, type TLShapeId } from "tldraw";
import type { CodexAgentEntry, CodexAgentShape } from "./codex-agent-types";

export const CODEX_AGENT_SHAPE_ID = createShapeId("codex-agent");

export function getCodexAgent(editor: Editor): CodexAgentShape | null {
  const shape = editor.getShape(CODEX_AGENT_SHAPE_ID);
  return shape?.type === "codex-agent" ? shape as CodexAgentShape : null;
}

export function createOrFocusCodexAgent(editor: Editor) {
  const existing = getCodexAgent(editor);
  if (!existing) {
    editor.createShape<CodexAgentShape>({
      id: CODEX_AGENT_SHAPE_ID,
      type: "codex-agent",
      x: 0,
      y: 0,
      props: {
        w: 1,
        h: 1,
        name: "Codex",
        entries: [],
        codexThreadId: null,
        isRunning: false,
        streamingText: "",
        activity: null,
        isOpen: true,
      },
    });
  } else {
    updateCodexAgent(editor, { isOpen: true });
  }
}

export function updateCodexAgent(editor: Editor, props: Partial<CodexAgentShape["props"]>) {
  if (!getCodexAgent(editor)) return false;
  editor.updateShape<CodexAgentShape>({ id: CODEX_AGENT_SHAPE_ID, type: "codex-agent", props });
  return true;
}

export function appendCodexAgentEntry(
  editor: Editor,
  entry: Omit<CodexAgentEntry, "id" | "createdAt">,
) {
  const shape = getCodexAgent(editor);
  if (!shape) return false;
  const next: CodexAgentEntry = {
    ...entry,
    id: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
    createdAt: Date.now(),
  };
  updateCodexAgent(editor, { entries: [...shape.props.entries, next] });
  return true;
}

export function getAgentContextShapeIds(editor: Editor): TLShapeId[] {
  const selected = editor.getSelectedShapeIds().filter((id) => id !== CODEX_AGENT_SHAPE_ID);
  if (selected.length > 0) return selected.slice(0, 8);
  return editor.getCurrentPageShapes()
    .filter((shape) => ["data-source", "sql-text-area", "chart-shape", "note"].includes(shape.type))
    .slice(0, 8)
    .map((shape) => shape.id);
}
