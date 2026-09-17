import { HTMLContainer, Rectangle2d, ShapeUtil, type TLShapeUtilCanBeLaidOutOpts } from "tldraw";
import { AgentChatProps } from "./agent-chat-props";
import type { AgentChatShape } from "./agent-chat-types";

export class AgentChatUtil extends ShapeUtil<AgentChatShape> {
  static override type = "agent-chat" as const;
  static override props = AgentChatProps;

  getDefaultProps(): AgentChatShape["props"] {
    return {
      w: 1,
      h: 1,
      name: "Agent",
      entries: [],
      threadId: null,
      isRunning: false,
      streamingText: "",
      activity: null,
      isOpen: false,
    };
  }

  override canBind() {
    return false;
  }
  override canResize() {
    return false;
  }
  override canSnap() {
    return false;
  }
  override canTabTo() {
    return false;
  }
  override canBeLaidOut(_shape: AgentChatShape, _info: TLShapeUtilCanBeLaidOutOpts) {
    return false;
  }
  override hideSelectionBoundsBg() {
    return true;
  }
  override hideSelectionBoundsFg() {
    return true;
  }
  override hideResizeHandles() {
    return true;
  }
  override hideRotateHandle() {
    return true;
  }

  getGeometry() {
    return new Rectangle2d({ width: 1, height: 1, isFilled: false });
  }

  component(shape: AgentChatShape) {
    return <HTMLContainer id={shape.id} style={{ display: "none" }} />;
  }

  indicator() {
    return null;
  }
}
