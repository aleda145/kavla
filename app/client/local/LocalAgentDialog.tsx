import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Bot, CheckCircle2, LayoutDashboard, Loader2, RefreshCw, ShieldCheck, Sparkles, X } from "lucide-react";
import { setCodexModelSelection, useCodexModels, useCodexStatus } from "../localServer/codexStore";
import { useData } from "../useLocalServer";

export function LocalAgentDialog({ onClose, onOpenChat }: { onClose: () => void; onOpenChat: () => void }) {
  const status = useCodexStatus();
  const modelSelection = useCodexModels();
  const { retryCodex } = useData();
  const ready = status.state === "ready";

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      aria-label="Kavla Agent connection"
      aria-modal="true"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
      style={{
        alignItems: "center",
        backgroundColor: "rgba(15,23,42,.32)",
        display: "flex",
        inset: 0,
        justifyContent: "center",
        padding: 20,
        pointerEvents: "all",
        position: "fixed",
        zIndex: 1_000_000,
      }}
    >
      <div
        style={{
          backgroundColor: "#fff",
          border: "3px solid #000",
          borderRadius: 12,
          boxShadow: "6px 6px 0 0 #000",
          color: "#000",
          fontFamily: "Inter, sans-serif",
          overflow: "hidden",
          width: "min(460px, calc(100vw - 40px))",
        }}
      >
        <div
          style={{
            alignItems: "center",
            backgroundColor: "#ffedd5",
            borderBottom: "3px solid #000",
            display: "flex",
            gap: 8,
            padding: "11px 14px",
          }}
        >
          <Bot size={18} strokeWidth={2.7} />
          <strong style={{ fontSize: 14, fontWeight: 900 }}>Agent connection</strong>
          <button
            aria-label="Close agent connection"
            onClick={onClose}
            style={{
              alignItems: "center",
              background: "#fff",
              border: "2px solid #000",
              borderRadius: 6,
              cursor: "pointer",
              display: "flex",
              height: 28,
              justifyContent: "center",
              marginLeft: "auto",
              padding: 0,
              width: 28,
            }}
            type="button"
          >
            <X size={17} strokeWidth={3} />
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16 }}>
          <div
            style={{
              alignItems: "center",
              background: ready ? "#dcfce7" : status.state === "checking" ? "#fef9c3" : "#fee2e2",
              border: "2px solid #000",
              borderRadius: 8,
              display: "flex",
              gap: 10,
              padding: 12,
            }}
          >
            {status.state === "checking" ? (
              <Loader2 className="animate-spin" size={22} />
            ) : ready ? (
              <CheckCircle2 color="#15803d" size={22} strokeWidth={3} />
            ) : (
              <Bot color="#991b1b" size={22} strokeWidth={3} />
            )}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 900 }}>Codex CLI</div>
              <div style={{ fontSize: 11, lineHeight: 1.4, marginTop: 2 }}>{status.message}</div>
            </div>
          </div>

          <div style={{ border: "2px solid #000", borderRadius: 8, overflow: "hidden" }}>
            <div
              style={{
                alignItems: "center",
                borderBottom: "1px solid #d6d3d1",
                display: "flex",
                gap: 9,
                padding: "9px 11px",
              }}
            >
              <Sparkles color="#9a3412" size={17} strokeWidth={3} />
              <div>
                <strong style={{ fontSize: 11 }}>Connected account</strong>
                <div style={{ color: "#57534e", fontSize: 10, marginTop: 1 }}>Uses Codex on the machine running Kavla</div>
              </div>
            </div>
            <div style={{ alignItems: "center", display: "flex", gap: 9, padding: "9px 11px" }}>
              <ShieldCheck color="#15803d" size={17} strokeWidth={3} />
              <div>
                <strong style={{ fontSize: 11 }}>Canvas-only access</strong>
                <div style={{ color: "#57534e", fontSize: 10, lineHeight: 1.4, marginTop: 1 }}>
                  Uses your canvas as context. Queries and new analysis stay visible on the canvas.
                </div>
              </div>
            </div>
          </div>

          <div
            style={{
              background: "#fff",
              border: "2px solid #000",
              borderRadius: 8,
              display: "flex",
              flexDirection: "column",
              gap: 10,
              padding: 11,
            }}
          >
            <div style={{ alignItems: "center", display: "flex", gap: 8 }}>
              <Sparkles color="#9a3412" size={17} strokeWidth={3} />
              <div>
                <strong style={{ fontSize: 11 }}>Agent models</strong>
                <div style={{ color: "#57534e", fontSize: 10, lineHeight: 1.35, marginTop: 1 }}>
                  Available through the connected Codex account.
                </div>
              </div>
            </div>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 10, fontWeight: 900 }}>Main agent</span>
              <select
                aria-label="Main agent model"
                disabled={!ready || modelSelection.models.length === 0}
                onChange={(event) => setCodexModelSelection("main", event.currentTarget.value)}
                style={{
                  background: "#fff",
                  border: "2px solid #000",
                  borderRadius: 6,
                  color: "#000",
                  font: "700 11px Inter, sans-serif",
                  height: 34,
                  padding: "0 8px",
                }}
                value={modelSelection.mainModel}
              >
                {modelSelection.models.map((model) => (
                  <option key={model.model} value={model.model}>
                    {model.displayName}
                  </option>
                ))}
              </select>
              <span style={{ color: "#57534e", fontSize: 9, lineHeight: 1.35 }}>
                Handles the conversation, analysis, queries, charts, and notes.
              </span>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ alignItems: "center", display: "flex", fontSize: 10, fontWeight: 900, gap: 5 }}>
                <LayoutDashboard size={12} strokeWidth={3} /> Layout planner
              </span>
              <select
                aria-label="Layout planner model"
                disabled={!ready || modelSelection.models.length === 0}
                onChange={(event) => setCodexModelSelection("layout", event.currentTarget.value)}
                style={{
                  background: "#fff",
                  border: "2px solid #000",
                  borderRadius: 6,
                  color: "#000",
                  font: "700 11px Inter, sans-serif",
                  height: 34,
                  padding: "0 8px",
                }}
                value={modelSelection.layoutModel}
              >
                {modelSelection.models.map((model) => (
                  <option key={model.model} value={model.model}>
                    {model.displayName}
                  </option>
                ))}
              </select>
              <span style={{ color: "#57534e", fontSize: 9, lineHeight: 1.35 }}>
                Plans the reading order before the main agent creates canvas artifacts.
              </span>
            </label>
          </div>

          <div style={{ alignItems: "center", display: "flex", gap: 8, justifyContent: "flex-end" }}>
            {!ready && status.state !== "checking" ? (
              <button
                onClick={retryCodex}
                style={{
                  alignItems: "center",
                  background: "#fff",
                  border: "2px solid #000",
                  borderRadius: 6,
                  cursor: "pointer",
                  display: "flex",
                  fontSize: 11,
                  fontWeight: 900,
                  gap: 5,
                  height: 32,
                  padding: "0 10px",
                }}
                type="button"
              >
                <RefreshCw size={13} strokeWidth={3} /> Retry
              </button>
            ) : null}
            <button
              disabled={!ready}
              onClick={onOpenChat}
              style={{
                alignItems: "center",
                background: "#ffedd5",
                border: "2px solid #000",
                borderRadius: 6,
                cursor: ready ? "pointer" : "default",
                display: "flex",
                fontSize: 11,
                fontWeight: 900,
                gap: 5,
                height: 32,
                opacity: ready ? 1 : 0.45,
                padding: "0 10px",
              }}
              type="button"
            >
              <Sparkles size={13} strokeWidth={3} /> Open chat
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
