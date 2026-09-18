import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type SyntheticEvent } from "react";
import { Loader2, Send, Square, Trash2, X } from "lucide-react";
import { useEditor, useValue, type TLShapeId } from "tldraw";
import { useAgentModels, useAgentStatus } from "../client/localServer/agentStore";
import { useData } from "../client/useLocalServer";
import { hydratePromptCanvasContext } from "./agentCanvasTools";
import { appendAgentChatEntry, createOrFocusAgentChat, getAgentChat, updateAgentChat } from "./agent-chat-store";
import { AGENT_BLOB_SHAPE_ID, getAgentBlob, removeAgentBlob, startAgentBlob } from "./agent-blob-store";
import type { AgentChatEntry } from "./agent-chat-types";
import { AgentRuntime } from "./AgentRuntime";
import { getCanvasBadges, getMentionRanges, getShapeCitations, type ContextBadge } from "./agent-shape-references";
import { agentClientId, agentRequest, getAgentRuns, isAgentRunActive, useAgentRuns } from "../client/localServer/agentRuns";
import { getActiveLocalSession, stageCanvas } from "../client/local/localSession";
import "./agent-chat.css";

const DOCK_ANCHOR_SIZE = 48;
const CHAT_WIDTH = 340;
const CHAT_HEIGHT = 330;
const TOOLBAR_GAP = 6;
const CHAT_GAP = 12;

function stopOverlayEvent(event: SyntheticEvent) {
  event.stopPropagation();
}

function getDockLayout() {
  const toolbarElements = Array.from(
    document.querySelectorAll<HTMLElement>(".tlui-layout__bottom .tlui-toolbar__inner")
  );
  const toolbar = toolbarElements
    .map((element) => ({ element, bounds: element.getBoundingClientRect() }))
    .filter(({ bounds }) => bounds.width > 0 && bounds.height > 0)
    .sort((a, b) => b.bounds.bottom - a.bounds.bottom)[0]?.bounds;
  const agentButton = Array.from(document.querySelectorAll<HTMLElement>("[data-kavla-agent-toolbar]"))
    .map((element) => element.getBoundingClientRect())
    .filter((bounds) => bounds.width > 0 && bounds.height > 0)
    .sort((a, b) => b.bottom - a.bottom)[0];
  const maxChatX = Math.max(18, window.innerWidth - CHAT_WIDTH - 18);
  const maxChatY = Math.max(18, window.innerHeight - CHAT_HEIGHT - 18);
  if (agentButton) {
    return {
      chat: {
        x: Math.max(18, Math.min((toolbar?.right ?? agentButton.right) + TOOLBAR_GAP, maxChatX)),
        y: Math.max(18, Math.min(agentButton.top - CHAT_HEIGHT - CHAT_GAP, maxChatY)),
      },
    };
  }
  if (!toolbar) {
    return {
      chat: {
        x: Math.max(18, window.innerWidth - CHAT_WIDTH - 24),
        y: Math.max(18, window.innerHeight - CHAT_HEIGHT - 92),
      },
    };
  }
  const maxAnchorX = Math.max(18, window.innerWidth - DOCK_ANCHOR_SIZE - 18);
  const anchorX = Math.max(18, Math.min(toolbar.right + TOOLBAR_GAP, maxAnchorX));
  return {
    chat: {
      x: Math.max(18, Math.min(anchorX + DOCK_ANCHOR_SIZE - CHAT_WIDTH, maxChatX)),
      y: Math.max(18, Math.min(toolbar.top - CHAT_HEIGHT - CHAT_GAP, maxChatY)),
    },
  };
}

function fallbackHistory(entries: AgentChatEntry[]): string {
  return entries
    .slice(-40)
    .map((entry) => `${entry.role}: ${entry.text}\nCanvas references: ${[...(entry.contextShapeIds ?? []), ...(entry.shapeIds ?? [])].join(", ")}`)
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

function AnswerText({ text, badgesById, onNavigate }: {
  text: string;
  badgesById: Map<string, ContextBadge>;
  onNavigate: (shapeId: string) => void;
}) {
  const citations = getShapeCitations(text);
  let offset = 0;
  return <>{citations.map((citation) => {
    const before = text.slice(offset, citation.from);
    offset = citation.to;
    const badge = badgesById.get(citation.shapeId);
    return <span key={citation.from}>{before}{badge ? (
      <button type="button" onClick={() => onNavigate(citation.shapeId)} title={`Go to ${badge.name}`}
        style={{ display: "inline", background: badge.backgroundColor, border: 0, borderBottom: `2px solid ${badge.borderBottomColor}`, padding: "0 2px", font: "inherit", cursor: "pointer" }}>
        {citation.label}
      </button>
    ) : <span title="This canvas shape is unavailable">{citation.label}</span>}</span>;
  })}{text.slice(offset)}</>;
}

function AgentChatOverlay() {
  const editor = useEditor();
  const dataSocket = useData();
  const agentStatus = useAgentStatus();
  const agentModels = useAgentModels();
  const [prompt, setPrompt] = useState("");
  const runs = useAgentRuns();
  const [isSending, setIsSending] = useState(false);
  const highlightsRef = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [dismissedMention, setDismissedMention] = useState<string | null>(null);
  const [chosenMentions, setChosenMentions] = useState<ContextBadge[]>([]);
  const [isFollowing, setIsFollowing] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [layout, setLayout] = useState(() => getDockLayout());
  const endRef = useRef<HTMLDivElement>(null);
  const agent = useValue("Kavla agent", () => getAgentChat(editor), [editor]);
  const canvasBadges = useValue("Kavla agent canvas references", () => getCanvasBadges(editor), [editor]);
  const selectedIds = useValue("Kavla agent selection", () => editor.getSelectedShapeIds(), [editor]);
  const selectedBadges = canvasBadges.filter((badge) => selectedIds.includes(badge.id as TLShapeId));
  const badgesById = useMemo(() => new Map(canvasBadges.map((badge) => [badge.id, badge])), [canvasBadges]);
  const mentionBadges = [...chosenMentions, ...canvasBadges.filter((badge) => !chosenMentions.some((chosen) => chosen.name === badge.name))];
  const mentionRanges = getMentionRanges(prompt, mentionBadges);
  const contextBadges = Array.from(new Map([
    ...selectedBadges,
    ...mentionRanges.map((range) => badgesById.get(range.badge.id)).filter((badge): badge is ContextBadge => Boolean(badge)),
  ].map((badge) => [badge.id, badge])).values());
  const mentionMatch = prompt.slice(0, cursor).match(/(?:^|[\s({])@([^@\n]*)$/);
  const mentionStart = mentionMatch ? cursor - mentionMatch[1].length - 1 : -1;
  const mentionKey = `${mentionStart}:${cursor}:${prompt}`;
  const completedMention = mentionRanges.some((range) => range.from === mentionStart && range.to < cursor);
  const showMentions = Boolean(mentionMatch && !completedMention && dismissedMention !== mentionKey);
  const mentionSuggestions = showMentions
    ? canvasBadges.filter((badge) => badge.name.toLowerCase().includes(mentionMatch![1].toLowerCase())).slice(0, 8)
    : [];
  const activeMentionIndex = Math.min(mentionIndex, Math.max(0, mentionSuggestions.length - 1));
  useEffect(() => {
    if (showMentions) document.getElementById(`agent-mention-${activeMentionIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [showMentions, activeMentionIndex]);
  const activeBounds = useValue("Kavla agent active shape", () => {
    const bounds = editor.getShapePageBounds(AGENT_BLOB_SHAPE_ID);
    return bounds ? { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h } : null;
  }, [editor]);

  useEffect(() => {
    if (!isFollowing || !activeBounds) return;
    editor.zoomToBounds(activeBounds, { targetZoom: editor.getZoomLevel(), inset: 80, animation: { duration: 220 } });
  }, [editor, isFollowing, activeBounds]);

  useEffect(() => {
    const pauseFollowing = (event: Event) => {
      if (event.target instanceof Element && event.target.closest("[data-kavla-agent-ui]")) return;
      setIsFollowing(false);
    };
    const container = editor.getContainer();
    const pauseForNavigationKey = (event: globalThis.KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "+", "-", "="].includes(event.key)) {
        pauseFollowing(event);
      }
    };
    container.addEventListener("pointerdown", pauseFollowing, true);
    container.addEventListener("wheel", pauseFollowing, true);
    container.addEventListener("keydown", pauseForNavigationKey, true);
    return () => {
      container.removeEventListener("pointerdown", pauseFollowing, true);
      container.removeEventListener("wheel", pauseFollowing, true);
      container.removeEventListener("keydown", pauseForNavigationKey, true);
    };
  }, [editor]);

  const chooseMention = (badge: ContextBadge) => {
    const token = `@${badge.name} `;
    const nextPrompt = prompt.slice(0, mentionStart) + token + prompt.slice(cursor);
    const nextCursor = mentionStart + token.length;
    setChosenMentions((current) => [...current.filter((item) => item.name !== badge.name), badge]);
    setPrompt(nextPrompt);
    setCursor(nextCursor);
    setMentionIndex(0);
    requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };
  const ready = agentStatus.state === "ready";
  const isOpen = agent?.props.isOpen ?? false;
  const isRunning = isSending || runs.some(isAgentRunActive) || (agent?.props.isRunning ?? false);

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
  }, [isOpen]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [agent?.props.entries, agent?.props.streamingText, agent?.props.activity]);

  const zoomToShape = (shapeId: string) => {
    const id = shapeId as TLShapeId;
    if (!editor.getShape(id)) return;
    setIsFollowing(false);
    editor.select(id);
    editor.zoomToSelection({ animation: { duration: 220 } });
  };

  const send = async () => {
    const text = prompt.trim();
    if (!text || isRunning || !ready) return;
    setIsSending(true);
    createOrFocusAgentChat(editor);
    const currentAgent = getAgentChat(editor);
    const contextShapeIds = contextBadges.map((badge) => badge.id);
    const runId = crypto.randomUUID();
    try {
      editor.run(() => startAgentBlob(editor, runId, contextShapeIds[0]), { history: "ignore" });
      const context = await hydratePromptCanvasContext(editor, dataSocket, contextShapeIds);
      if (getAgentRuns().some(isAgentRunActive)) throw new Error("The Agent started another run. Wait or stop it before sending.");
      await stageCanvas(editor);
      await agentRequest("prompts", {
        runId, clientId: agentClientId, documentId: getActiveLocalSession()?.documentId,
        prompt: text, threadId: currentAgent?.props.threadId ?? null,
        context: { ...context, mentions: mentionRanges.map(({ badge }) => ({ name: badge.name, shapeId: badge.id })) },
        fallbackHistory: fallbackHistory(currentAgent?.props.entries ?? []),
        mainModel: agentModels.mainModel,
      });
      const latest = getAgentChat(editor);
      const userEntry = latest?.props.entries.find((entry) => entry.role === "user" && entry.runId === runId);
      if (userEntry) updateAgentChat(editor, { entries: latest!.props.entries.map((entry) => entry.id === userEntry.id ? { ...entry, contextShapeIds } : entry) });
      else appendAgentChatEntry(editor, { role: "user", runId, text, contextShapeIds });
      setPrompt(""); setCursor(0); setChosenMentions([]); setDismissedMention(null);
    } catch (error) {
      if (getAgentBlob(editor)?.props.currentJobId === runId) {
        editor.run(() => removeAgentBlob(editor), { history: "ignore" });
      }
      appendAgentChatEntry(editor, { role: "error", text: error instanceof Error ? error.message : String(error) });
    } finally { setIsSending(false); }
  };

  const onPromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (showMentions) {
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedMention(mentionKey);
        return;
      }
      if (mentionSuggestions.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        setMentionIndex((activeMentionIndex + (event.key === "ArrowDown" ? 1 : -1) + mentionSuggestions.length) % mentionSuggestions.length);
        return;
      }
      if (mentionSuggestions.length && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) {
        event.preventDefault();
        chooseMention(mentionSuggestions[activeMentionIndex]);
        return;
      }
    }
    if ((event.key === "Backspace" || event.key === "Delete") && event.currentTarget.selectionStart === event.currentTarget.selectionEnd) {
      const position = event.currentTarget.selectionStart;
      const mention = mentionRanges.find((range) => event.key === "Backspace" ? range.to === position : range.from === position);
      if (mention) {
        event.preventDefault();
        setPrompt(prompt.slice(0, mention.from) + prompt.slice(mention.to));
        setCursor(mention.from);
        requestAnimationFrame(() => promptRef.current?.setSelectionRange(mention.from, mention.from));
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const visualStatus = !ready ? "Unavailable" : isRunning ? "Thinking" : "Ready";

  return (
    <div
      data-kavla-agent-ui
      style={{ fontFamily: '"Kavla Agent Inter", sans-serif', inset: 0, pointerEvents: "none", position: "fixed", zIndex: 100000 }}
    >
      <style>{`
        @keyframes kavla-agent-thinking-dot { 0%, 80%, 100% { opacity: .35; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-2px); } }
      `}</style>
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
              background: "#ede9fe",
              borderBottom: "3px solid #000",
              borderRadius: "9px 9px 0 0",
              display: "flex",
              gap: 8,
              minHeight: 42,
              padding: "6px 8px",
            }}
          >
            <strong style={{ fontSize: 11, fontWeight: 900, textTransform: "uppercase" }}>Analyst</strong>
            <div style={{ alignItems: "center", display: "flex", gap: 6, marginLeft: "auto" }}>
              <button
                aria-label="Follow analyst"
                aria-pressed={isFollowing}
                onClick={() => setIsFollowing((value) => !value)}
                title="Follow active work. Moving around the canvas pauses following."
                type="button"
                style={{ display: "flex", alignItems: "center", justifyContent: "center", background: isFollowing ? "#fef08a" : "#fff", color: "#000", border: "2px solid #000", borderRadius: 5, height: 24, padding: "0 6px", fontSize: 9, fontWeight: 900, textTransform: "uppercase", cursor: "pointer" }}
              >
                Follow
              </button>
              <button
                aria-label="Clear chat"
                disabled={isRunning}
                onClick={() =>
                  updateAgentChat(editor, { entries: [], threadId: null, streamingText: "", activity: null, historyClearedAt: Date.now() })
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
              <button
                aria-label="Close agent chat"
                onClick={() => updateAgentChat(editor, { isOpen: false })}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", background: "#fff", border: "2px solid #000", borderRadius: 5, height: 24, width: 24, padding: 0, cursor: "pointer" }}
                title="Close chat"
                type="button"
              >
                <X size={13} strokeWidth={3} />
              </button>
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
              {agentStatus.message}
              <button
                onClick={() => dataSocket.retryAgent()}
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
              background: "#faf5ff",
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
                Select shapes or type @ to mention them, then ask the Agent to explore, create, or edit your analysis.
              </div>
            ) : null}
            {agent.props.entries.map((entry) => {
              if (entry.role === "event" && entry.toolCallId && entry.text.includes(" needs correction:")) return null;
              const isUser = entry.role === "user";
              const isError = entry.role === "error";
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
                  {isUser && contextBadges.length ? (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 5 }}>
                      {contextBadges.map((badge) => (
                        <ContextChip badge={badge} key={badge.id} onClick={() => zoomToShape(badge.id)} />
                      ))}
                    </div>
                  ) : null}
                  <AnswerText text={entry.text} badgesById={badgesById} onNavigate={zoomToShape} />
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
                  lineHeight: 1.35,
                  maxWidth: "92%",
                  padding: "6px 8px",
                }}
              >
                <Loader2 className="animate-spin" size={14} strokeWidth={3} /> {agent.props.activity}
              </div>
            ) : null}
            <div ref={endRef} />
          </div>

          <div style={{ background: "#fff", borderRadius: "0 0 9px 9px", borderTop: "3px solid #000", padding: 7, position: "relative" }}>
            {contextBadges.length ? (
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
                {contextBadges.map((badge) => (
                  <ContextChip badge={badge} key={badge.id} onClick={() => zoomToShape(badge.id)} />
                ))}
              </div>
            ) : null}
            {showMentions && ready && !isRunning ? (
              <div id="agent-mention-list" role="listbox" aria-label="Canvas shapes" style={{ position: "absolute", bottom: "calc(100% + 6px)", left: 8, right: 8, maxHeight: 210, overflowY: "auto", background: "#fff", border: "2px solid #000", borderRadius: 6, boxShadow: "4px 4px 0 #000", zIndex: 1 }}>
                {mentionSuggestions.length ? mentionSuggestions.map((badge, index) => (
                  <button
                    key={badge.id}
                    id={`agent-mention-${index}`}
                    role="option"
                    aria-selected={index === activeMentionIndex}
                    type="button"
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => chooseMention(badge)}
                    style={{ display: "flex", alignItems: "center", width: "100%", minWidth: 0, textAlign: "left", background: index === activeMentionIndex ? "#ede9fe" : "#fff", border: 0, borderBottom: index === mentionSuggestions.length - 1 ? 0 : "1px solid #e5e7eb", padding: "7px 8px", fontSize: 12, fontWeight: 850, cursor: "pointer" }}
                  >
                    <span style={{ fontFamily: "monospace", background: badge.backgroundColor, borderBottom: `2px solid ${badge.borderBottomColor}`, padding: "0 2px", fontWeight: 900, display: "block", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{badge.name}</span>
                  </button>
                )) : <div style={{ padding: "7px 8px", fontSize: 12, fontWeight: 850, color: "#6b7280" }}>No matching context</div>}
              </div>
            ) : null}
            <div
              style={{
                background: "#fff",
                border: "2px solid #000",
                borderRadius: 6,
                minHeight: 58,
                overflow: "hidden",
                position: "relative",
              }}
            >
              <div ref={highlightsRef} aria-hidden="true" style={{ position: "absolute", inset: 0, padding: "7px 56px 7px 8px", boxSizing: "border-box", whiteSpace: "pre-wrap", overflowWrap: "break-word", overflow: "hidden", font: '700 12px/1.35 "Kavla Agent Inter", sans-serif', color: "#000", pointerEvents: "none" }}>
                {(() => {
                  let offset = 0;
                  return <>{mentionRanges.map((range) => {
                    const prefix = prompt.slice(offset, range.from);
                    offset = range.to;
                    return <span key={`${range.from}:${range.badge.id}`}>{prefix}<span style={{ background: range.badge.backgroundColor, borderBottom: `1px solid ${range.badge.borderBottomColor}`, borderRadius: 3 }}>{prompt.slice(range.from, range.to)}</span></span>;
                  })}{prompt.slice(offset)}{"\n"}</>;
                })()}
              </div>
              <textarea
                ref={promptRef}
                onScroll={(event) => { if (highlightsRef.current) highlightsRef.current.scrollTop = event.currentTarget.scrollTop; }}
                aria-label="Ask the Kavla Agent"
                aria-autocomplete="list"
                aria-controls={showMentions ? "agent-mention-list" : undefined}
                aria-activedescendant={showMentions && mentionSuggestions.length ? `agent-mention-${activeMentionIndex}` : undefined}
                disabled={!ready || isRunning}
                onChange={(event) => {
                  setPrompt(event.currentTarget.value);
                  setCursor(event.currentTarget.selectionStart);
                  setMentionIndex(0);
                  setDismissedMention(null);
                }}
                onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
                onKeyDown={onPromptKeyDown}
                placeholder={contextBadges.length ? "Ask about this" : "Ask about this canvas"}
                style={{
                  background: "transparent",
                  border: 0,
                  boxSizing: "border-box",
                  color: "transparent",
                  caretColor: "#000",
                  position: "relative",
                  display: "block",
                  font: '700 12px/1.35 "Kavla Agent Inter", sans-serif',
                  height: 58,
                  outline: 0,
                  padding: "7px 56px 7px 8px",
                  resize: "none",
                  width: "100%",
                }}
                value={prompt}
              />
              {isRunning ? (
                <button
                  aria-label="Stop agent"
                  onClick={() => dataSocket.cancelAgent()}
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
                    background: "#ede9fe",
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

export function AgentLayer() {
  if (!getActiveLocalSession()) return null;
  return (
    <>
      <AgentRuntime />
      <AgentChatOverlay />
    </>
  );
}
