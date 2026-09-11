import { HTMLContainer, Rectangle2d, ShapeUtil, type TLShapeUtilCanBeLaidOutOpts } from "tldraw";
import { CodexAgentMigrations } from "./codex-agent-migrations";
import { CodexAgentProps } from "./codex-agent-props";
import type { CodexAgentShape } from "./codex-agent-types";

export class CodexAgentUtil extends ShapeUtil<CodexAgentShape> {
  static override type = "codex-agent" as const;
  static override props = CodexAgentProps;
  static override migrations = CodexAgentMigrations;

  getDefaultProps(): CodexAgentShape["props"] {
    return {
      w: 1,
      h: 1,
      name: "Codex",
      entries: [],
      codexThreadId: null,
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
  override canBeLaidOut(_shape: CodexAgentShape, _info: TLShapeUtilCanBeLaidOutOpts) {
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

  component(shape: CodexAgentShape) {
    return <HTMLContainer id={shape.id} style={{ display: "none" }} />;
  }

  indicator() {
    return null;
  }
}
