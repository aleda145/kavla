import { HTMLContainer, Rectangle2d, ShapeUtil, TLResizeInfo, resizeBox } from "tldraw";
import { CLITerminalProps } from "./cli-terminal-props";
import { CLITerminalMigrations } from "./cli-terminal-migrations";
import { CLITerminalShape } from "./cli-terminal-types";
import { useCliStatus, useCliOutput } from "../client/useLocalServer";
import { useCallback, useLayoutEffect, useRef } from "react";
import { TldrawScrollAreaIndicator } from "../DataSource/TldrawScrollAreaIndicator";
import { useTldrawScrollArea } from "../DataSource/useTldrawScrollArea";
import { getCliTerminalDisplay } from "../client/cliTerminalDisplay";

export class CLITerminalUtil extends ShapeUtil<CLITerminalShape> {
  static override type = "cli-terminal" as const;
  static override props = CLITerminalProps;
  static override migrations = CLITerminalMigrations;

  override canEdit() {
    return false;
  }
  override canResize() {
    return true;
  }
  override isAspectRatioLocked() {
    return false;
  }

  getDefaultProps(): CLITerminalShape["props"] {
    return {
      w: 400,
      h: 250,
    };
  }

  getGeometry(shape: CLITerminalShape) {
    return new Rectangle2d({
      width: shape.props.w,
      height: shape.props.h,
      isFilled: true,
    });
  }

  override onResize(shape: CLITerminalShape, info: TLResizeInfo<CLITerminalShape>) {
    return resizeBox(shape, info);
  }

  indicator(shape: CLITerminalShape) {
    return <rect width={shape.props.w} height={shape.props.h} />;
  }

  component(shape: CLITerminalShape) {
    const cliConnected = useCliStatus();
    const cliOutput = useCliOutput();
    const cliTerminalDisplay = getCliTerminalDisplay(cliConnected, cliOutput);

    const scrollArea = useTldrawScrollArea();
    const showCliInstallLink = cliTerminalDisplay.state === "not-connected-empty";
    const bodyRef = useRef<HTMLTextAreaElement>(null);
    const setBodyRef = useCallback(
      (node: HTMLTextAreaElement | null) => {
        bodyRef.current = node;
        scrollArea.ref(node);
        if (node) {
          node.scrollTop = node.scrollHeight;
        }
      },
      [scrollArea.ref]
    );

    useLayoutEffect(() => {
      const body = bodyRef.current;
      if (!body) return;
      body.scrollTop = body.scrollHeight;
    }, [cliTerminalDisplay.outputText]);

    return (
      <HTMLContainer
        id={shape.id}
        style={{
          width: shape.props.w,
          height: shape.props.h,
          backgroundColor: "#1a1a2e", // Same as tooltip
          borderRadius: 8,
          border: "4px solid #000",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          pointerEvents: "all",
        }}
        onPointerDown={() => {}}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px",
            backgroundColor: "#16213e",
            borderBottom: "2px solid #000",
            flexShrink: 0,
            cursor: "grab", // Indicate draggable area
          }}
          onPointerDown={() => {}}
        >
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              backgroundColor:
                cliTerminalDisplay.tone === "connected"
                  ? "#4ade80"
                  : cliTerminalDisplay.tone === "disconnected"
                    ? "#ef4444"
                    : "#94a3b8",
              border: "1px solid rgba(0,0,0,0.5)",
            }}
          />
          <span
            style={{
              fontSize: 12,
              fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
              color: "#94a3b8",
              fontWeight: 600,
            }}
          >
            Terminal — {cliTerminalDisplay.headerLabel}
          </span>
        </div>

        {showCliInstallLink ? (
          <div
            style={{
              padding: "10px 14px",
              flex: 1,
              overflowY: "auto",
              fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
              fontSize: 11,
              lineHeight: 1.6,
              color: "#e2e8f0",
              backgroundColor: "transparent",
              whiteSpace: "pre-wrap",
            }}
          >
            <span>{cliTerminalDisplay.emptyStateText}</span>
          </div>
        ) : (
          <>
            <textarea
              readOnly
              ref={setBodyRef}
              style={{
                padding: "10px 14px",
                flex: 1,
                overflowY: "auto",
                fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                fontSize: 11,
                lineHeight: 1.6,
                color: "#e2e8f0",
                backgroundColor: "transparent",
                border: "none",
                outline: "none",
                resize: "none",
              }}
              onWheel={scrollArea.onWheel}
              onPointerDown={scrollArea.onPointerDown}
              onPointerMove={scrollArea.onPointerMove}
              onPointerUp={scrollArea.onPointerUp}
              onPointerCancel={scrollArea.onPointerCancel}
              value={cliTerminalDisplay.outputText ?? cliTerminalDisplay.emptyStateText ?? ""}
            />
            <TldrawScrollAreaIndicator indicator={scrollArea.indicator} />
          </>
        )}
      </HTMLContainer>
    );
  }
}
