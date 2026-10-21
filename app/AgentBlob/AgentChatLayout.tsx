import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const AgentChatLayoutContext = createContext<{
  container: HTMLDivElement | null;
  isMaximized: boolean;
  setIsMaximized: (value: boolean) => void;
  isMobile: boolean;
  isMobileOpen: boolean;
  setIsMobileOpen: (value: boolean) => void;
  mobileContainer: HTMLDivElement | null;
  mobileLauncherContainer: HTMLDivElement | null;
} | null>(null);

export function useAgentChatLayout() {
  const layout = useContext(AgentChatLayoutContext);
  if (!layout) throw new Error("Agent chat requires AgentChatLayout");
  return layout;
}

export function AgentChatLayout({ children }: { children: ReactNode }) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 840px)").matches
  );
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [mobileContainer, setMobileContainer] = useState<HTMLDivElement | null>(null);
  const [mobileLauncherContainer, setMobileLauncherContainer] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 840px)");
    const update = () => {
      setIsMobile(query.matches);
      setIsMobileOpen(false);
    };
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return (
    <AgentChatLayoutContext.Provider
      value={{
        container,
        isMaximized,
        setIsMaximized,
        isMobile,
        isMobileOpen,
        setIsMobileOpen,
        mobileContainer,
        mobileLauncherContainer,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: isMobile ? "column" : "row",
          height: "100%",
          width: "100%",
          position: "relative",
        }}
      >
        <div style={{ flex: "1 1 0", minWidth: 0, minHeight: 0, position: "relative" }}>
          {children}
          <div
            ref={setMobileLauncherContainer}
            style={{
              display: isMobile ? "block" : "none",
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
              zIndex: 300,
            }}
          />
        </div>
        <div
          ref={setMobileContainer}
          style={{
            display: isMobile && isMobileOpen ? "block" : "none",
            position: "relative",
            flex: "0 0 45%",
            minHeight: 0,
            borderTop: "6px solid #000",
            boxSizing: "border-box",
            overflow: "hidden",
          }}
        />
        <div
          ref={setContainer}
          style={{
            display: isMobile ? "none" : undefined,
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
