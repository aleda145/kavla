import { BaseBoxShapeTool } from "tldraw";
import { getCliSourcesSnapshot } from "../client/useLocalServer";
import { calculateDataSourcePickerHeight, DATA_SOURCE_PICKER_WIDTH } from "./CliSourcesList";

export class SourceTextAreaTool extends BaseBoxShapeTool {
  static override id = "data-source";
  static override initial = "idle";
  override shapeType = "data-source";

  override onPointerDown() {
    const { currentPagePoint } = this.editor.inputs;
    const height = calculateDataSourcePickerHeight(getCliSourcesSnapshot().length);
    this.editor.createShape({
      type: this.shapeType,
      x: currentPagePoint.x - DATA_SOURCE_PICKER_WIDTH / 2,
      y: currentPagePoint.y - height / 2,
      props: {
        w: DATA_SOURCE_PICKER_WIDTH,
        h: height,
      },
    });
    this.editor.setCurrentTool("select");
  }
}
