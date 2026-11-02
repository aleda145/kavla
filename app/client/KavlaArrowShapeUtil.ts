import {
  ArrowBindingUtil,
  ArrowShapeUtil,
  getArrowBindings,
  type BindingOnChangeOptions,
  type BindingOnCreateOptions,
  type BindingOnDeleteOptions,
  type BindingOnShapeChangeOptions,
  type Editor,
  type TLArrowBinding,
  type TLArrowShape,
  type TLShape,
  type TLShapeId,
} from "tldraw";
import { routeConnectorLanes } from "./canvas/connectorLanes";

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
  private laneNodes = new Set<TLShapeId>();

  private queueLanes(binding: TLArrowBinding) {
    if (!this.isKavlaConnectorArrow(binding.fromId)) return;
    this.laneNodes.add(binding.toId);
    const arrow = this.editor.getShape<TLArrowShape>(binding.fromId);
    if (!arrow) return;
    const { start, end } = getArrowBindings(this.editor, arrow);
    if (start) this.laneNodes.add(start.toId);
    if (end) this.laneNodes.add(end.toId);
  }

  override onOperationComplete(): void {
    if (!this.laneNodes.size) return;
    const nodes = this.laneNodes;
    this.laneNodes = new Set();
    routeConnectorLanes(this.editor, nodes);
  }

  override onBeforeDelete({ binding }: BindingOnDeleteOptions<TLArrowBinding>): void {
    this.queueLanes(binding);
  }

  override onAfterCreate(options: BindingOnCreateOptions<TLArrowBinding>): void {
    if (this.removeInvalidKnobBinding(options.binding)) return;
    this.queueLanes(options.binding);
    if (!this.isKavlaConnectorArrow(options.binding.fromId)) {
      super.onAfterCreate(options);
    }
  }

  override onAfterChange(options: BindingOnChangeOptions<TLArrowBinding>): void {
    if (this.removeInvalidKnobBinding(options.bindingAfter)) return;
    // Compare with the assigned port, since tldraw batches intermediate updates.
    // A user adjusting the port takes ownership of that route.
    const { normalizedAnchor, isPrecise, isExact, snap } = options.bindingAfter.props;
    if (
      options.bindingAfter.meta.kavlaLane === true &&
      (options.bindingAfter.meta.kavlaLaneAnchor !== `${normalizedAnchor.x},${normalizedAnchor.y}` ||
        !isPrecise ||
        isExact ||
        snap !== "none")
    ) {
      this.releaseLane(options.bindingAfter.fromId);
    }
    // Port/midpoint updates from the lane pass don't queue another pass.
    if (
      options.bindingBefore.toId !== options.bindingAfter.toId ||
      options.bindingBefore.fromId !== options.bindingAfter.fromId
    ) {
      this.queueLanes(options.bindingBefore);
      this.queueLanes(options.bindingAfter);
    }
    if (!this.isKavlaConnectorArrow(options.bindingAfter.fromId)) {
      super.onAfterChange(options);
    }
  }

  override onAfterChangeFromShape(options: BindingOnShapeChangeOptions<TLArrowBinding>): void {
    const before = options.shapeBefore as TLArrowShape;
    const after = options.shapeAfter as TLArrowShape;
    if (
      typeof after.meta.kavlaLaneMidpoint === "number" &&
      after.props.elbowMidPoint !== after.meta.kavlaLaneAssignedMidpoint
    )
      this.releaseLane(after.id);
    if (
      before.props.kind !== after.props.kind ||
      before.isLocked !== after.isLocked ||
      before.x !== after.x ||
      before.y !== after.y ||
      before.rotation !== after.rotation ||
      before.parentId !== after.parentId ||
      options.reason === "ancestry"
    )
      this.queueLanes(options.binding);
    if (!this.isKavlaConnectorArrow(options.shapeAfter.id)) {
      super.onAfterChangeFromShape(options);
    }
  }

  override onAfterChangeToShape(options: BindingOnShapeChangeOptions<TLArrowBinding>): void {
    const { shapeBefore: before, shapeAfter: after } = options;
    const beforeSize = before.props as { w?: number; h?: number };
    const afterSize = after.props as { w?: number; h?: number };
    if (
      options.reason === "ancestry" ||
      before.x !== after.x ||
      before.y !== after.y ||
      before.rotation !== after.rotation ||
      before.parentId !== after.parentId ||
      beforeSize.w !== afterSize.w ||
      beforeSize.h !== afterSize.h
    )
      this.queueLanes(options.binding);
    if (!this.isKavlaConnectorArrow(options.binding.fromId)) {
      super.onAfterChangeToShape(options);
    }
  }

  private isKavlaConnectorArrow(shapeId: TLShape["id"]) {
    const shape = this.editor.getShape<TLArrowShape>(shapeId);
    return shape?.type === "arrow" && shape.meta?.kavlaConnector === true;
  }

  private releaseLane(arrowId: TLShapeId) {
    const arrow = this.editor.getShape<TLArrowShape>(arrowId);
    if (!arrow || arrow.meta.kavlaConnector !== true) return;
    const { start, end } = getArrowBindings(this.editor, arrow);
    for (const binding of [start, end]) {
      if (binding?.meta.kavlaLane !== true) continue;
      this.editor.updateBinding({ id: binding.id, type: "arrow", meta: { kavlaLane: false, kavlaLaneAnchor: null } });
    }
    if (typeof arrow.meta.kavlaLaneMidpoint === "number") {
      this.editor.updateShape({
        id: arrow.id,
        type: "arrow",
        meta: { kavlaLaneMidpoint: null, kavlaLaneAssignedMidpoint: null },
      });
    }
  }

  private removeInvalidKnobBinding(binding: TLArrowBinding): boolean {
    const arrow = this.editor.getShape<TLArrowShape>(binding.fromId);
    if (!arrow) return false;
    const bindings = getArrowBindings(this.editor, arrow);
    const start = bindings.start && this.editor.getShape(bindings.start.toId);
    const end = bindings.end && this.editor.getShape(bindings.end.toId);
    if (end?.type === "knob" || (start?.type === "knob" && end && end.type !== "sql-text-area")) {
      this.editor.deleteBindings([binding.id]);
      return true;
    }
    return false;
  }
}
