import { HTMLContainer, Rectangle2d, ShapeUtil, type TLResizeInfo, resizeBox } from "tldraw";
import { useMemo } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { AgentBlobMigrations } from "./agent-blob-migrations";
import { AgentBlobProps } from "./agent-blob-props";
import type { AgentBlobShape, AgentBlobStatus } from "./agent-blob-types";
import { createOrFocusAgentChat } from "./agent-chat-store";

function statusLabel(status: AgentBlobStatus) {
  if (status === "thinking") return "Thinking";
  if (status === "working") return "Working";
  if (status === "done") return "Done";
  if (status === "error") return "Stuck";
  return "Ask";
}

export class AgentBlobUtil extends ShapeUtil<AgentBlobShape> {
  static override type = "agent-blob" as const;
  static override props = AgentBlobProps;
  static override migrations = AgentBlobMigrations;

  override isAspectRatioLocked(_shape: AgentBlobShape) {
    return false;
  }

  override canResize(_shape: AgentBlobShape) {
    return false;
  }

  override onDoubleClick() {
    createOrFocusAgentChat(this.editor);
  }

  getDefaultProps(): AgentBlobShape["props"] {
    return {
      w: 56,
      h: 56,
      name: "Analyst",
      status: "idle",
      currentJobId: null,
      lastMessage: null,
      targetShapeIds: null,
      createdAt: Date.now(),
      lastFinishedAt: null,
    };
  }

  getGeometry(shape: AgentBlobShape) {
    return new Rectangle2d({
      width: shape.props.w,
      height: shape.props.h,
      isFilled: true,
    });
  }

  component(shape: AgentBlobShape) {
    const blobStyle = useMemo(() => {
      const wobble = shape.props.status === "thinking" || shape.props.status === "working";
      return {
        animation: wobble ? "kavla-agent-blob-breathe 1.6s ease-in-out infinite" : undefined,
        borderRadius: 999,
      };
    }, [shape.props.status]);

    return (
      <HTMLContainer
        id={shape.id}
        style={{
          pointerEvents: "all",
          width: "100%",
          height: "100%",
          overflow: "visible",
          fontFamily: "Inter, sans-serif",
        }}
      >
        <style>
          {`
            @keyframes kavla-agent-blob-breathe {
              0%, 100% { transform: scale(1) rotate(-2deg); }
              50% { transform: scale(1.08) rotate(2deg); }
            }
          `}
        </style>
        <div
          title={shape.props.lastMessage ? `${shape.props.lastMessage} · Double-click to open chat` : "Double-click to open chat"}
          style={{
            ...blobStyle,
            width: "100%",
            height: "100%",
            border: "3px solid #000",
            borderRadius: 999,
            background: "#ede9fe",
            color: "#6d28d9",
            boxShadow: "4px 4px 0px 0px rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            position: "relative",
          }}
        >
          {shape.props.status === "thinking" || shape.props.status === "working" ? (
            <Loader2 size={24} strokeWidth={3} className="animate-spin" />
          ) : (
            <Sparkles size={25} strokeWidth={3} />
          )}
          <span
            style={{
              position: "absolute",
              left: "50%",
              bottom: -24,
              transform: "translateX(-50%)",
              padding: "2px 7px",
              border: "2px solid #000",
              borderRadius: 5,
              background:
                shape.props.status === "error" ? "#fee2e2" : shape.props.status === "done" ? "#dcfce7" : "#fff",
              color: "#000",
              fontSize: 10,
              fontWeight: 900,
              whiteSpace: "nowrap",
              pointerEvents: "none",
            }}
          >
            {statusLabel(shape.props.status)}
          </span>
        </div>
      </HTMLContainer>
    );
  }

  indicator(shape: AgentBlobShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={24} ry={24} />;
  }

  onResize(shape: AgentBlobShape, info: TLResizeInfo<AgentBlobShape>) {
    return resizeBox(shape, info);
  }
}
