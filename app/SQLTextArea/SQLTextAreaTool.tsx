import { BaseBoxShapeTool } from "tldraw";
export class SQLTextAreaTool extends BaseBoxShapeTool {
  static override id = "sql-text-area";
  static override initial = "idle";
  override shapeType = "sql-text-area";

  override onPointerDown() {
    const { currentPagePoint } = this.editor.inputs;
    this.editor.createShape({
      type: this.shapeType,
      x: currentPagePoint.x - 150, // Half of default width 300
      y: currentPagePoint.y - 150, // Half of default height 300
    });
    this.editor.setCurrentTool("select");
  }
}
