import { createContext, useContext, useState, type ReactNode } from "react";

const AgentChatLayoutContext = createContext<{
  container: HTMLDivElement | null;
  isMaximized: boolean;
  setIsMaximized: (value: boolean) => void;
} | null>(null);

export function useAgentChatLayout() {
  const layout = useContext(AgentChatLayoutContext);
  if (!layout) throw new Error("Agent chat requires AgentChatLayout");
  return layout;
}

export function AgentChatLayout({ children }: { children: ReactNode }) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);

  return (
    <AgentChatLayoutContext.Provider value={{ container, isMaximized, setIsMaximized }}>
      <div style={{ display: "flex", height: "100%", width: "100%", position: "relative" }}>
        <div style={{ flex: "1 1 0", minWidth: 0, position: "relative" }}>{children}</div>
        <div
          ref={setContainer}
          style={{
            position: isMaximized ? "relative" : "absolute",
            inset: isMaximized ? undefined : 0,
            flex: isMaximized ? "0 0 25%" : undefined,
            minWidth: isMaximized ? "min(340px, 50%)" : undefined,
            pointerEvents: "none",
            zIndex: 299,
          }}
        />
      </div>
    </AgentChatLayoutContext.Provider>
  );
}
