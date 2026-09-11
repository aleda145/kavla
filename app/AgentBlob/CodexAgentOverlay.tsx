import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type SyntheticEvent } from "react";
import { Bot, ExternalLink, Loader2, Send, Sparkles, Square, Trash2 } from "lucide-react";
import { useEditor, useValue, type TLShape, type TLShapeId } from "tldraw";
import { useCodexModels, useCodexStatus } from "../client/localServer/codexStore";
import { useData } from "../client/useLocalServer";
import { buildPromptCanvasContext } from "./codexCanvasTools";
import { appendCodexAgentEntry, createOrFocusCodexAgent, getCodexAgent, updateCodexAgent } from "./codex-agent-store";
import type { CodexAgentEntry } from "./codex-agent-types";
import { CodexAgentRuntime } from "./CodexAgentRuntime";
import { getActiveLocalSession } from "../client/local/localSession";

const LAUNCHER_SIZE = 48;
const CHAT_WIDTH = 340;
const CHAT_HEIGHT = 360;
const TOOLBAR_GAP = 6;
const CHAT_GAP = 12;

type ContextBadge = {
  id: string;
  name: string;
  backgroundColor: string;
  borderBottomColor: string;
};

function stopOverlayEvent(event: SyntheticEvent) {
  event.stopPropagation();
}

function getShapeName(shape: TLShape): string {
  if ("name" in shape.props && typeof shape.props.name === "string" && shape.props.name.trim()) {
    return shape.props.name.trim();
  }
  if (shape.type === "note") return "note";
  if (shape.type === "sql-result-table") return "result";
  return shape.type.replace(/-/g, " ");
}

function getShapeColors(shape: TLShape) {
  if (shape.type === "data-source") return { backgroundColor: "#dbeafe", borderBottomColor: "#3b82f6" };
  if (shape.type === "sql-text-area") return { backgroundColor: "#fef9c3", borderBottomColor: "#ca8a04" };
  if (shape.type === "sql-result-table") return { backgroundColor: "#dcfce7", borderBottomColor: "#16a34a" };
  if (shape.type === "chart-shape") return { backgroundColor: "#fce7f3", borderBottomColor: "#db2777" };
  if (shape.type === "note") return { backgroundColor: "#ffedd5", borderBottomColor: "#f97316" };
  return { backgroundColor: "#fff", borderBottomColor: "#000" };
}

function getContextBadge(shape: TLShape): ContextBadge {
  return { id: shape.id, name: getShapeName(shape), ...getShapeColors(shape) };
}

function isContextShape(shape: TLShape) {
  return ["data-source", "sql-text-area", "sql-result-table", "chart-shape", "note"].includes(shape.type);
}

function getDockLayout() {
  const toolbarElements = Array.from(
    document.querySelectorAll<HTMLElement>(".tlui-layout__bottom .tlui-toolbar__inner")
  );
  const toolbar = toolbarElements
    .map((element) => ({ element, bounds: element.getBoundingClientRect() }))
    .filter(({ bounds }) => bounds.width > 0 && bounds.height > 0)
    .sort((a, b) => b.bounds.bottom - a.bounds.bottom)[0]?.bounds;
  const maxLauncherX = Math.max(18, window.innerWidth - LAUNCHER_SIZE - 18);
  const maxLauncherY = Math.max(18, window.innerHeight - LAUNCHER_SIZE - 18);
  const launcher = toolbar
    ? {
        x: Math.max(18, Math.min(toolbar.right + TOOLBAR_GAP, maxLauncherX)),
        y: Math.max(18, Math.min(toolbar.top + toolbar.height / 2 - LAUNCHER_SIZE / 2, maxLauncherY)),
      }
    : { x: maxLauncherX, y: maxLauncherY };
  return {
    launcher,
    chat: {
      x: Math.max(18, Math.min(launcher.x + LAUNCHER_SIZE - CHAT_WIDTH, window.innerWidth - CHAT_WIDTH - 18)),
      y: Math.max(18, Math.min(launcher.y - CHAT_HEIGHT - CHAT_GAP, window.innerHeight - CHAT_HEIGHT - 18)),
    },
  };
}

function fallbackHistory(entries: CodexAgentEntry[]): string {
  return entries
    .filter((entry) => entry.role === "user" || entry.role === "assistant")
    .slice(-20)
    .map((entry) => `${entry.role === "user" ? "User" : "Assistant"}: ${entry.text}`)
    .join("\n\n")
    .slice(-24_000);
}

function ContextChip({ badge, onClick }: { badge: ContextBadge; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        backgroundColor: badge.backgroundColor,
        border: 0,
        borderBottom: `2px solid ${badge.borderBottomColor}`,
        cursor: "pointer",
        display: "inline-block",
        fontFamily: "monospace",
        fontSize: 11,
        fontWeight: 900,
        maxWidth: 180,
        overflow: "hidden",
        padding: "1px 3px",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
      title={badge.name}
      type="button"
    >
      @{badge.name}
    </button>
  );
}

function CodexChatOverlay() {
  const editor = useEditor();
  const dataSocket = useData();
  const codexStatus = useCodexStatus();
  const codexModels = useCodexModels();
  const [prompt, setPrompt] = useState("");
  const [layout, setLayout] = useState(() => getDockLayout());
  const endRef = useRef<HTMLDivElement>(null);
  const agent = useValue("Kavla Codex agent", () => getCodexAgent(editor), [editor]);
  const selectedBadges = useValue(
    "Kavla Codex context selection",
    () => editor.getSelectedShapes().filter(isContextShape).map(getContextBadge),
    [editor]
  );
  const ready = codexStatus.state === "ready";
  const isOpen = agent?.props.isOpen ?? false;
  const isRunning = agent?.props.isRunning ?? false;

  useLayoutEffect(() => {
    const update = () => setLayout(getDockLayout());
    update();
    const timers = [window.setTimeout(update, 100), window.setTimeout(update, 500)];
    window.addEventListener("resize", update);
    const toolbar = document.querySelector<HTMLElement>(".tlui-layout__bottom .tlui-toolbar__inner");
    const observer = toolbar ? new ResizeObserver(update) : null;
    if (toolbar && observer) observer.observe(toolbar);
    return () => {
      timers.forEach(window.clearTimeout);
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [agent?.props.entries, agent?.props.streamingText, agent?.props.activity]);

  const badgesById = useMemo(() => {
    return new Map(
      editor
        .getCurrentPageShapes()
        .filter(isContextShape)
        .map((shape) => {
          const badge = getContextBadge(shape);
          return [badge.id, badge] as const;
        })
    );
  }, [editor, agent?.props.entries, selectedBadges]);

  const zoomToShape = (shapeId: string) => {
    const id = shapeId as TLShapeId;
    if (!editor.getShape(id)) return;
    editor.select(id);
    editor.zoomToSelection({ animation: { duration: 220 } });
  };

  const send = () => {
    const text = prompt.trim();
    if (!text || isRunning || !ready) return;
    createOrFocusCodexAgent(editor);
    const currentAgent = getCodexAgent(editor);
    const contextShapeIds = selectedBadges.map((badge) => badge.id);
    appendCodexAgentEntry(editor, { role: "user", text, contextShapeIds });
    updateCodexAgent(editor, { isRunning: true, streamingText: "", activity: "Starting Codex…", isOpen: true });
    dataSocket.sendCodexPrompt({
      prompt: text,
      threadId: currentAgent?.props.codexThreadId ?? null,
      context: buildPromptCanvasContext(editor, contextShapeIds),
      fallbackHistory: fallbackHistory(currentAgent?.props.entries ?? []),
      mainModel: codexModels.mainModel,
      layoutModel: codexModels.layoutModel,
    });
    setPrompt("");
  };

  const onPromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  const visualStatus = !ready ? "Unavailable" : isRunning ? "Thinking" : "Ready";

  return (
    <div
      style={{ fontFamily: "Inter, sans-serif", inset: 0, pointerEvents: "none", position: "fixed", zIndex: 100000 }}
    >
      <style>{`
        @keyframes kavla-codex-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
        @keyframes kavla-codex-thinking-dot { 0%, 80%, 100% { opacity: .35; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-2px); } }
      `}</style>
      <div
        style={{
          height: LAUNCHER_SIZE,
          left: layout.launcher.x,
          pointerEvents: "all",
          position: "absolute",
          top: layout.launcher.y,
          width: LAUNCHER_SIZE,
        }}
      >
        <button
          aria-expanded={isOpen}
          aria-label="Open Kavla Agent chat"
          onClick={(event) => {
            event.stopPropagation();
            if (!agent) createOrFocusCodexAgent(editor);
            else updateCodexAgent(editor, { isOpen: !isOpen });
          }}
          onPointerDown={stopOverlayEvent}
          style={{
            alignItems: "center",
            animation: isRunning ? "kavla-codex-float 4.8s ease-in-out infinite" : undefined,
            background: "#ffedd5",
            border: "2px solid #000",
            borderRadius: 999,
            boxShadow: "2px 2px 0 0 rgba(0,0,0,.35)",
            color: ready ? "#9a3412" : "#991b1b",
            cursor: "pointer",
            display: "flex",
            height: "100%",
            justifyContent: "center",
            padding: 0,
            width: "100%",
          }}
          title="Kavla Agent"
          type="button"
        >
          {isRunning ? (
            <Loader2 className="animate-spin" size={20} strokeWidth={3} />
          ) : (
            <Sparkles size={21} strokeWidth={3} />
          )}
        </button>
      </div>

      {isOpen && agent ? (
        <aside
          aria-label="Kavla Agent chat"
          onClick={stopOverlayEvent}
          onContextMenu={stopOverlayEvent}
          onDoubleClick={stopOverlayEvent}
          onKeyDown={stopOverlayEvent}
          onMouseDown={stopOverlayEvent}
          onPointerDown={stopOverlayEvent}
          onWheel={stopOverlayEvent}
          style={{
            background: "#fff",
            border: "3px solid #000",
            borderRadius: 12,
            boxShadow: "4px 4px 0 0 #000",
            display: "flex",
            flexDirection: "column",
            height: CHAT_HEIGHT,
            left: layout.chat.x,
            overflow: "visible",
            pointerEvents: "all",
            position: "absolute",
            top: layout.chat.y,
            width: CHAT_WIDTH,
          }}
        >
          <div
            style={{
              alignItems: "center",
              background: "#ffedd5",
              borderBottom: "3px solid #000",
              borderRadius: "9px 9px 0 0",
              display: "flex",
              gap: 8,
              minHeight: 42,
              padding: "6px 8px",
            }}
          >
            <Bot size={16} strokeWidth={3} />
            <strong style={{ fontSize: 11, fontWeight: 900, textTransform: "uppercase" }}>Analyst</strong>
            <div style={{ alignItems: "center", display: "flex", gap: 6, marginLeft: "auto" }}>
              <button
                aria-label="Clear chat"
                disabled={isRunning}
                onClick={() =>
                  updateCodexAgent(editor, { entries: [], codexThreadId: null, streamingText: "", activity: null })
                }
                style={{
                  alignItems: "center",
                  background: "#fff",
                  border: "2px solid #000",
                  borderRadius: 5,
                  cursor: isRunning ? "default" : "pointer",
                  display: "flex",
                  height: 24,
                  justifyContent: "center",
                  opacity: isRunning ? 0.45 : 1,
                  padding: 0,
                  width: 24,
                }}
                title="Clear chat"
                type="button"
              >
                <Trash2 size={13} strokeWidth={3} />
              </button>
              <div
                style={{
                  background: ready ? "#fff" : "#fee2e2",
                  border: "2px solid #000",
                  borderRadius: 5,
                  fontSize: 9,
                  fontWeight: 900,
                  padding: "2px 6px",
                  textTransform: "uppercase",
                }}
              >
                {visualStatus}
              </div>
            </div>
          </div>

          {!ready ? (
            <div
              style={{
                background: "#fee2e2",
                borderBottom: "2px solid #000",
                color: "#7f1d1d",
                fontSize: 10,
                lineHeight: 1.35,
                padding: "6px 8px",
              }}
            >
              {codexStatus.message}
              <button
                onClick={() => dataSocket.retryCodex()}
                style={{
                  background: "#fff",
                  border: "1px solid #000",
                  borderRadius: 4,
                  cursor: "pointer",
                  fontSize: 9,
                  fontWeight: 900,
                  marginLeft: 6,
                }}
                type="button"
              >
                Retry
              </button>
            </div>
          ) : null}

          <div
            style={{
              background: "#fffaf5",
              display: "flex",
              flex: "1 1 auto",
              flexDirection: "column",
              gap: 7,
              minHeight: 0,
              overflowY: "auto",
              padding: 10,
              userSelect: "text",
            }}
          >
            {agent.props.entries.length === 0 ? (
              <div style={{ color: "#57534e", fontSize: 12, lineHeight: 1.45, padding: 4 }}>
                Select something on the canvas to add it as context, then ask Codex to explore it or create analytical
                work.
              </div>
            ) : null}
            {agent.props.entries.map((entry) => {
              const isUser = entry.role === "user";
              const isError = entry.role === "error";
              const linkedIds = entry.shapeIds ?? [];
              const contextBadges = (entry.contextShapeIds ?? [])
                .map((id) => badgesById.get(id))
                .filter((badge): badge is ContextBadge => Boolean(badge));
              return (
                <div
                  key={entry.id}
                  style={{
                    alignSelf: isUser ? "flex-end" : "flex-start",
                    background: isError ? "#fee2e2" : entry.role === "event" ? "#e0f2fe" : "#fff",
                    border: "2px solid #000",
                    borderRadius: 7,
                    boxShadow: "2px 2px 0 0 rgba(0,0,0,.16)",
                    fontSize: 12,
                    fontWeight: 750,
                    lineHeight: 1.35,
                    maxWidth: "92%",
                    padding: "6px 8px",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {contextBadges.length ? (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 5 }}>
                      {contextBadges.map((badge) => (
                        <ContextChip badge={badge} key={badge.id} onClick={() => zoomToShape(badge.id)} />
                      ))}
                    </div>
                  ) : null}
                  {entry.text}
                  {linkedIds.length ? (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 5 }}>
                      {linkedIds.map((id) => {
                        const badge = badgesById.get(id);
                        return badge ? (
                          <ContextChip badge={badge} key={id} onClick={() => zoomToShape(id)} />
                        ) : (
                          <button
                            key={id}
                            onClick={() => zoomToShape(id)}
                            style={{
                              background: "#ccfbf1",
                              border: 0,
                              borderBottom: "2px solid #0f766e",
                              cursor: "pointer",
                              fontFamily: "monospace",
                              fontSize: 11,
                              fontWeight: 900,
                            }}
                            type="button"
                          >
                            <ExternalLink size={10} /> Canvas shape
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {agent.props.streamingText ? (
              <div
                style={{
                  alignSelf: "flex-start",
                  background: "#fff",
                  border: "2px solid #000",
                  borderRadius: 7,
                  boxShadow: "2px 2px 0 0 rgba(0,0,0,.16)",
                  fontSize: 12,
                  fontWeight: 750,
                  lineHeight: 1.35,
                  maxWidth: "92%",
                  padding: "6px 8px",
                  whiteSpace: "pre-wrap",
                }}
              >
                {agent.props.streamingText}
              </div>
            ) : null}
            {agent.props.activity ? (
              <div
                style={{
                  alignItems: "center",
                  alignSelf: "flex-start",
                  background: "#fef9c3",
                  border: "2px solid #000",
                  borderRadius: 7,
                  boxShadow: "2px 2px 0 0 rgba(0,0,0,.16)",
                  display: "flex",
                  fontSize: 12,
                  fontWeight: 900,
                  gap: 7,
                  padding: "6px 8px",
                }}
              >
                <Loader2 className="animate-spin" size={14} strokeWidth={3} /> {agent.props.activity}
              </div>
            ) : null}
            <div ref={endRef} />
          </div>

          <div style={{ background: "#fff", borderRadius: "0 0 9px 9px", borderTop: "3px solid #000", padding: 7 }}>
            {selectedBadges.length ? (
              <div
                style={{
                  alignItems: "center",
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 4,
                  marginBottom: 6,
                  maxHeight: 44,
                  overflowY: "auto",
                }}
              >
                <span style={{ color: "#57534e", fontSize: 9, fontWeight: 900, textTransform: "uppercase" }}>
                  Context
                </span>
                {selectedBadges.map((badge) => (
                  <ContextChip badge={badge} key={badge.id} onClick={() => zoomToShape(badge.id)} />
                ))}
              </div>
            ) : null}
            <div
              style={{
                background: "#fff",
                border: "2px solid #000",
                borderRadius: 6,
                minHeight: 64,
                overflow: "hidden",
                position: "relative",
              }}
            >
              <textarea
                aria-label="Ask the Kavla Agent"
                disabled={!ready || isRunning}
                onChange={(event) => setPrompt(event.currentTarget.value)}
                onKeyDown={onPromptKeyDown}
                placeholder={selectedBadges.length ? "Ask about this" : "Ask about this canvas"}
                style={{
                  background: "transparent",
                  border: 0,
                  boxSizing: "border-box",
                  color: "#000",
                  font: "12px/1.4 Inter, sans-serif",
                  height: 64,
                  outline: 0,
                  padding: "7px 42px 7px 8px",
                  resize: "none",
                  width: "100%",
                }}
                value={prompt}
              />
              {isRunning ? (
                <button
                  aria-label="Stop agent"
                  onClick={() => dataSocket.cancelCodex()}
                  style={{
                    alignItems: "center",
                    background: "#fee2e2",
                    border: "2px solid #000",
                    borderRadius: 5,
                    bottom: 7,
                    cursor: "pointer",
                    display: "flex",
                    height: 28,
                    justifyContent: "center",
                    padding: 0,
                    position: "absolute",
                    right: 6,
                    width: 28,
                  }}
                  type="button"
                >
                  <Square fill="currentColor" size={11} />
                </button>
              ) : (
                <button
                  aria-label="Send"
                  disabled={!ready || !prompt.trim()}
                  onClick={send}
                  style={{
                    alignItems: "center",
                    background: "#ffedd5",
                    border: "2px solid #000",
                    borderRadius: 5,
                    bottom: 7,
                    cursor: ready && prompt.trim() ? "pointer" : "default",
                    display: "flex",
                    height: 28,
                    justifyContent: "center",
                    opacity: ready && prompt.trim() ? 1 : 0.5,
                    padding: 0,
                    position: "absolute",
                    right: 6,
                    width: 28,
                  }}
                  type="button"
                >
                  <Send size={13} strokeWidth={3} />
                </button>
              )}
            </div>
          </div>
        </aside>
      ) : null}
    </div>
  );
}

export function CodexAgentLayer() {
  if (!getActiveLocalSession()) return null;
  return (
    <>
      <CodexAgentRuntime />
      <CodexChatOverlay />
    </>
  );
}
