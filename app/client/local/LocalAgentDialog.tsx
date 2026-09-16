import { notifyCodexAuth, useCodexAuth, type CodexAuth } from "../localServer/codexAuth";
import { cancelCodexRun, codexRequest, isCodexRunActive, useCodexRuns } from "../localServer/codexRuns";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, LayoutDashboard, Loader2, RefreshCw, Sparkles, X } from "lucide-react";
import { setCodexModelSelection, useCodexModels, useCodexStatus } from "../localServer/codexStore";
import { useData } from "../useLocalServer";

export function LocalAgentDialog({ onClose, onOpenChat }: { onClose: () => void; onOpenChat: () => void }) {
  const status = useCodexStatus();
  const modelSelection = useCodexModels();
  const { retryCodex } = useData();
  const ready = status.state === "ready";
  const runs = useCodexRuns();
  const [runError, setRunError] = useState<string | null>(null);
  const auth = useCodexAuth();
  const [authMode, setAuthMode] = useState<CodexAuth["mode"]>(auth.mode);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(auth.baseUrl);
  const [apiModel, setApiModel] = useState(auth.model);
  const [extraHeaders, setExtraHeaders] = useState("");
  const [savingAuth, setSavingAuth] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const hasActiveRun = runs.some(isCodexRunActive);
  const authDisabled = savingAuth || hasActiveRun || status.state === "checking";
  const canUseProvider = baseUrl.trim().length > 0 && apiModel.trim().length > 0;
  const sameEndpoint = baseUrl.trim().replace(/\/+$/, "") === auth.baseUrl.replace(/\/+$/, "");

  useEffect(() => { setAuthMode(auth.mode); }, [auth.mode]);
  useEffect(() => { setBaseUrl(auth.baseUrl); setApiModel(auth.model); }, [auth.baseUrl, auth.model]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/codex/auth", { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load Agent authentication settings.");
        notifyCodexAuth(await response.json());
      }).catch((error) => { if (!controller.signal.aborted) setAuthError(error instanceof Error ? error.message : String(error)); });
    return () => controller.abort();
  }, []);

  const saveAuth = async () => {
    if (authDisabled || (authMode === "apiKey" && !canUseProvider)) return;
    setSavingAuth(true);
    setAuthError(null);
    const key = apiKey.trim();
    try {
      let headers: Record<string, string> | undefined;
      if (authMode === "apiKey" && extraHeaders.trim()) {
        const parsed: unknown = JSON.parse(extraHeaders);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((value) => typeof value !== "string")) {
          throw new Error('Extra headers must be a JSON object with string values, such as {"cf-aig-gateway-id":"kavla"}.');
        }
        headers = parsed as Record<string, string>;
      }
      const settings = await codexRequest<CodexAuth>("auth", {
        mode: authMode,
        ...(authMode === "apiKey" ? { baseUrl: baseUrl.trim(), model: apiModel.trim(), ...(key ? { apiKey: key } : {}), ...(headers ? { headers } : {}) } : {}),
      });
      setApiKey("");
      setExtraHeaders("");
      notifyCodexAuth(settings);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : String(error));
    } finally { setSavingAuth(false); }
  };

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
          overflowY: "auto",
          maxHeight: "calc(100vh - 40px)",
          width: "min(620px, calc(100vw - 40px))",
        }}
      >
        <div
          style={{
            alignItems: "center",
            backgroundColor: "#ede9fe",
            borderBottom: "3px solid #000",
            display: "flex",
            gap: 8,
            padding: "11px 14px",
          }}
        >
          <Sparkles color="#6d28d9" size={18} strokeWidth={2.7} />
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
              <Sparkles color="#991b1b" size={22} strokeWidth={3} />
            )}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 900 }}>{auth.mode === "apiKey" ? "API provider" : "Codex CLI"}</div>
              <div style={{ fontSize: 11, lineHeight: 1.4, marginTop: 2 }}>{ready ? "Connected" : status.message}</div>
            </div>
          </div>

          <form onSubmit={(event) => { event.preventDefault(); void saveAuth(); }} style={{ border: "2px solid #000", borderRadius: 8, padding: 11, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "flex-end", flexWrap: "wrap", gap: 8 }}>
            <label style={{ fontSize: 11, fontWeight: 900, display: "flex", flexDirection: "column", gap: 5, flex: "1 1 180px", minWidth: 0 }}>
              Connection
              <select aria-label="Agent connection method" value={authMode} disabled={authDisabled} onChange={(event) => { setAuthMode(event.currentTarget.value as CodexAuth["mode"]); setApiKey(""); setExtraHeaders(""); setAuthError(null); }} style={{ height: 34, border: "2px solid #000", borderRadius: 6, padding: "0 8px", background: "#fff", color: "#000", font: "700 11px Inter, sans-serif" }}>
                <option value="codex">Codex login</option>
                <option value="apiKey">API provider</option>
              </select>
            </label>
            <button type="submit" disabled={authDisabled || (authMode === "apiKey" && !canUseProvider)} style={{ flexShrink: 0, height: 34, border: "2px solid #000", borderRadius: 6, background: "#ede9fe", fontSize: 11, fontWeight: 900, padding: "0 10px", cursor: authDisabled ? "default" : "pointer", opacity: authDisabled || (authMode === "apiKey" && !canUseProvider) ? 0.5 : 1 }}>
              {savingAuth ? "Saving…" : authMode === "apiKey" ? "Use API provider" : "Use Codex login"}
            </button>
            </div>
            {authMode === "apiKey" ? <>
              <label style={{ fontSize: 11, fontWeight: 800, display: "flex", flexDirection: "column", gap: 5 }}>
                Base URL
                <input type="url" aria-label="API base URL" value={baseUrl} disabled={authDisabled} onChange={(event) => setBaseUrl(event.currentTarget.value)} placeholder="https://api.openai.com/v1" spellCheck={false} autoCapitalize="none" style={{ height: 34, border: "2px solid #000", borderRadius: 6, padding: "0 8px", background: "#fff", color: "#000", fontSize: 12 }} />
              </label>
              <label style={{ fontSize: 11, fontWeight: 800, display: "flex", flexDirection: "column", gap: 5 }}>
                Model ID
                <input aria-label="API model ID" value={apiModel} disabled={authDisabled} onChange={(event) => setApiModel(event.currentTarget.value)} placeholder="gpt-4.1" spellCheck={false} autoCapitalize="none" style={{ height: 34, border: "2px solid #000", borderRadius: 6, padding: "0 8px", background: "#fff", color: "#000", fontSize: 12 }} />
              </label>
              <label style={{ fontSize: 11, fontWeight: 800, display: "flex", flexDirection: "column", gap: 5 }}>
                API key
                <input type="password" autoComplete="off" spellCheck={false} autoCapitalize="none" aria-label="API key" value={apiKey} disabled={authDisabled} onChange={(event) => setApiKey(event.currentTarget.value)} placeholder={sameEndpoint && auth.hasApiKey ? "Leave blank to keep the current key" : "Optional if your provider needs no key"} style={{ height: 34, border: "2px solid #000", borderRadius: 6, padding: "0 8px", background: "#fff", color: "#000", fontSize: 12 }} />
              </label>
              <details>
                <summary style={{ fontSize: 11, fontWeight: 800, cursor: "pointer" }}>Extra headers (optional)</summary>
                <label style={{ fontSize: 10, display: "flex", flexDirection: "column", gap: 5, marginTop: 6 }}>
                  Headers as JSON
                  <textarea aria-label="API extra headers" value={extraHeaders} disabled={authDisabled} onChange={(event) => setExtraHeaders(event.currentTarget.value)} placeholder={sameEndpoint && auth.hasHeaders ? "Leave blank to keep saved headers; {} to clear." : '{"cf-aig-gateway-id":"kavla"}'} autoComplete="off" spellCheck={false} autoCapitalize="none" rows={3} style={{ border: "2px solid #000", borderRadius: 6, padding: 8, background: "#fff", color: "#000", fontSize: 11, resize: "vertical" }} />
                </label>
              </details>
              <div style={{ fontSize: 10, lineHeight: 1.4, color: "#57534e" }}>
                Use a Chat Completions-compatible provider with tool calling. Omit /chat/completions from the URL.
                {sameEndpoint && auth.keySource === "environment" ? " Using the server’s API key." : ""}
                {!sameEndpoint && (auth.hasApiKey || auth.hasHeaders) ? " New URL: re-enter your credentials." : ""}
              </div>
            </> : auth.mode === "apiKey" ? <div style={{ fontSize: 10, lineHeight: 1.4, color: "#57534e" }}>Switching clears saved API credentials.</div> : null}
            {hasActiveRun && <div style={{ fontSize: 10, color: "#57534e" }}>Stop the current run before changing the connection.</div>}
            {authError && <div role="alert" style={{ fontSize: 11, color: "#991b1b" }}>{authError}</div>}
          </form>

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
              <Sparkles color="#6d28d9" size={17} strokeWidth={3} />
              <strong style={{ fontSize: 11 }}>Models</strong>
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
                Used when layout planning is enabled in chat.
              </span>
            </label>
          </div>

          {runs.length > 0 && <details aria-label="Recent agent runs" style={{ border: "2px solid #000", borderRadius: 8, padding: 10 }}>
            <summary style={{ fontSize: 12, fontWeight: 800, cursor: "pointer" }}>Recent runs</summary>
            <div style={{ maxHeight: 190, overflowY: "auto", marginTop: 6 }}>
              {[...runs].reverse().slice(0, 10).map((run) => <div key={run.id} style={{ borderTop: "1px solid #d6d3d1", padding: "7px 0", fontSize: 11 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  {isCodexRunActive(run) && <Loader2 size={12} className="animate-spin" />}
                  <strong style={{ flex: 1 }}>{run.status.replace(/_/g, " ")}</strong>
                  {isCodexRunActive(run) && <button type="button" onClick={() => { void cancelCodexRun(run.id).catch((error) => setRunError(String(error))); }} style={{ border: "2px solid #000", borderRadius: 4, background: "#fee2e2", cursor: "pointer", fontWeight: 800 }}>Stop</button>}
                </div>
                <div style={{ marginTop: 3 }}>{run.prompt.slice(0, 160)}</div>
                <div style={{ color: "#57534e", fontSize: 10, marginTop: 3 }}>{run.model} · {run.tools.filter((call) => call.status === "completed").length}/{run.tools.length} steps · {new Date(run.createdAt).toLocaleTimeString()}</div>
                {(run.activity || run.error) && <div style={{ marginTop: 3, color: run.error ? "#991b1b" : "#57534e" }}>{run.error || run.activity}</div>}
              </div>)}
            </div>
            {runError && <div role="alert" style={{ color: "#991b1b", fontSize: 11 }}>{runError}</div>}
          </details>}

          <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
            <span style={{ color: "#57534e", fontSize: 10, marginRight: "auto" }}>Config: <code>~/.kavla/agent.yaml</code></span>
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
                background: "#ede9fe",
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
