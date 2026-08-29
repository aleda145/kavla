import {
  createShapeId,
  Editor,
  getIndexBelow,
  type IndexKey,
  TLArrowBinding,
  TLArrowShape,
  TLParentId,
  TLShapeId,
  Vec,
} from "tldraw";

function getArrowIndexBelowParentNodes(editor: Editor, parentId: TLParentId, arrowId: TLShapeId) {
  const firstNonArrowId = editor.getSortedChildIdsForParent(parentId).find((id) => {
    if (id === arrowId) {
      return false;
    }

    return editor.getShape(id)?.type !== "arrow";
  });
  const firstNonArrow = firstNonArrowId ? editor.getShape(firstNonArrowId) : null;

  return firstNonArrow ? getIndexBelow(firstNonArrow.index as IndexKey) : ("a1" as IndexKey);
}

export default function createArrowBetweenShapes(
  editor: Editor,
  startShapeId: TLShapeId,
  endShapeId: TLShapeId,
  options = {} as {
    parentId?: TLShapeId;
    start?: Partial<Omit<TLArrowBinding["props"], "terminal">>;
    end?: Partial<Omit<TLArrowBinding["props"], "terminal">>;
  }
) {
  const { start = {}, end = {}, parentId } = options;

  const {
    normalizedAnchor: startNormalizedAnchor = { x: 0.5, y: 0.5 },
    isExact: startIsExact = false,
    isPrecise: startIsPrecise = false,
  } = start;
  const {
    normalizedAnchor: endNormalizedAnchor = { x: 0.5, y: 0.5 },
    isExact: endIsExact = false,
    isPrecise: endIsPrecise = false,
  } = end;

  const startTerminalNormalizedPosition = Vec.From(startNormalizedAnchor);
  const endTerminalNormalizedPosition = Vec.From(endNormalizedAnchor);

  const parent = parentId ? editor.getShape(parentId) : undefined;
  if (parentId && !parent) throw Error(`Parent shape with id ${parentId} not found`);

  const startShapePageBounds = editor.getShapePageBounds(startShapeId);
  const endShapePageBounds = editor.getShapePageBounds(endShapeId);
  if (!startShapePageBounds || !endShapePageBounds) return;

  const startShapePageRotation = editor.getShapePageTransform(startShapeId).rotation();
  const endShapePageRotation = editor.getShapePageTransform(endShapeId).rotation();

  const startTerminalPagePosition = Vec.Add(
    startShapePageBounds.point,
    Vec.MulV(startShapePageBounds.size, Vec.Rot(startTerminalNormalizedPosition, startShapePageRotation))
  );
  const endTerminalPagePosition = Vec.Add(
    endShapePageBounds.point,
    Vec.MulV(startShapePageBounds.size, Vec.Rot(endTerminalNormalizedPosition, endShapePageRotation))
  );

  const arrowPointInParentSpace = Vec.Min(startTerminalPagePosition, endTerminalPagePosition);
  if (parent) {
    arrowPointInParentSpace.setTo(editor.getShapePageTransform(parent.id)!.applyToPoint(arrowPointInParentSpace));
  }

  const arrowId = createShapeId();

  const startShape = editor.getShape(startShapeId);
  const endShape = editor.getShape(endShapeId);
  if (!startShape || !endShape) return;

  if (startShapeId === endShapeId) return;

  editor.run(() => {
    const arrowParentId = parentId ?? editor.getCurrentPageId();
    editor.createShape<TLArrowShape>({
      id: arrowId,
      type: "arrow",
      parentId: arrowParentId,
      index: getArrowIndexBelowParentNodes(editor, arrowParentId, arrowId),
      meta: {
        kavlaConnector: true,
      },
      x: arrowPointInParentSpace.x,
      y: arrowPointInParentSpace.y,
      props: {
        kind: "elbow",
        size: "s",
        start: {
          x: arrowPointInParentSpace.x - startTerminalPagePosition.x,
          y: arrowPointInParentSpace.y - startTerminalPagePosition.y,
        },
        end: {
          x: arrowPointInParentSpace.x - endTerminalPagePosition.x,
          y: arrowPointInParentSpace.y - endTerminalPagePosition.y,
        },
      },
    });

    editor.createBindings<TLArrowBinding>([
      {
        fromId: arrowId,
        toId: startShapeId,
        type: "arrow",
        props: {
          terminal: "start",
          normalizedAnchor: startNormalizedAnchor,
          isExact: startIsExact,
          isPrecise: startIsPrecise,
        },
      },
      {
        fromId: arrowId,
        toId: endShapeId,
        type: "arrow",
        props: {
          terminal: "end",
          normalizedAnchor: endNormalizedAnchor,
          isExact: endIsExact,
          isPrecise: endIsPrecise,
        },
      },
    ]);
  });
}
