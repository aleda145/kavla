import {
  ArrowBindingUtil,
  ArrowShapeUtil,
  type BindingOnChangeOptions,
  type BindingOnCreateOptions,
  type BindingOnShapeChangeOptions,
  type Editor,
  type TLArrowBinding,
  type TLArrowShape,
  type TLShape,
} from "tldraw";

function getArrowBindableTargetAtPointer(editor: Editor): TLShape | undefined {
  return editor.getShapeAtPoint(editor.inputs.currentPagePoint, {
    hitInside: true,
    hitFrameInside: true,
    margin: 8,
    filter: (shape) =>
      !shape.isLocked &&
      editor.getShapeUtil(shape).canBind({
        fromShapeType: "arrow",
        toShapeType: shape.type,
        bindingType: "arrow",
      }),
  });
}

export const KavlaArrowShapeUtil = ArrowShapeUtil.configure({
  shouldBeExact: (editor: Editor) => {
    if (editor.inputs.altKey) {
      return true;
    }

    const target = getArrowBindableTargetAtPointer(editor);
    return target?.type === "chart-shape";
  },
});

export class KavlaArrowBindingUtil extends ArrowBindingUtil {
  override onAfterCreate(options: BindingOnCreateOptions<TLArrowBinding>): void {
    if (!this.isKavlaConnectorArrow(options.binding.fromId)) {
      super.onAfterCreate(options);
    }
  }

  override onAfterChange(options: BindingOnChangeOptions<TLArrowBinding>): void {
    if (!this.isKavlaConnectorArrow(options.bindingAfter.fromId)) {
      super.onAfterChange(options);
    }
  }

  override onAfterChangeFromShape(options: BindingOnShapeChangeOptions<TLArrowBinding>): void {
    if (!this.isKavlaConnectorArrow(options.shapeAfter.id)) {
      super.onAfterChangeFromShape(options);
    }
  }

  override onAfterChangeToShape(options: BindingOnShapeChangeOptions<TLArrowBinding>): void {
    if (!this.isKavlaConnectorArrow(options.binding.fromId)) {
      super.onAfterChangeToShape(options);
    }
  }

  private isKavlaConnectorArrow(shapeId: TLShape["id"]) {
    const shape = this.editor.getShape<TLArrowShape>(shapeId);
    return shape?.type === "arrow" && shape.meta?.kavlaConnector === true;
  }
}
