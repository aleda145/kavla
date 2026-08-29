import { getArrowBindings, type Editor, type TLArrowShape, type TLShape, type TLShapeId } from "tldraw";
import type { DataSourceShape } from "../DataSource/data-source-types";
import type { SQLTextAreaShape } from "../SQLTextArea/sql-text-area-types";
import createArrowBetweenShapes from "./CreateArrowBetweenShapes";

type ConnectionShape = DataSourceShape | SQLTextAreaShape;
type ConnectionProps = Pick<ConnectionShape["props"], "downstreamShapeIds" | "upstreamShapeIds">;

interface ConnectorArrow {
  arrowId: TLShapeId;
  startShapeId: TLShapeId | null;
  endShapeId: TLShapeId | null;
}

function isConnectionShape(shape: TLShape | undefined): shape is ConnectionShape {
  return shape?.type === "data-source" || shape?.type === "sql-text-area";
}

function updateConnectionProps(editor: Editor, shape: ConnectionShape, props: Partial<ConnectionProps>) {
  if (shape.type === "data-source") {
    editor.updateShape<DataSourceShape>({
      id: shape.id,
      type: "data-source",
      props,
    });
    return;
  }

  editor.updateShape<SQLTextAreaShape>({
    id: shape.id,
    type: "sql-text-area",
    props,
  });
}

function addId(ids: string[] | null, id: TLShapeId): string[] {
  return ids?.includes(id) ? ids : [...(ids ?? []), id];
}

function removeId(ids: string[] | null, id: TLShapeId): string[] {
  return (ids ?? []).filter((candidate) => candidate !== id);
}

function getConnectorArrows(editor: Editor): ConnectorArrow[] {
  return editor
    .getCurrentPageShapes()
    .filter((shape): shape is TLArrowShape => shape.type === "arrow" && shape.meta?.kavlaConnector === true)
    .map((arrow) => {
      const bindings = getArrowBindings(editor, arrow);
      return {
        arrowId: arrow.id,
        startShapeId: bindings.start?.toId ?? null,
        endShapeId: bindings.end?.toId ?? null,
      };
    });
}

function ensureConnectorArrow(editor: Editor, upstreamShapeId: TLShapeId, downstreamShapeId: TLShapeId) {
  const exists = getConnectorArrows(editor).some(
    (connector) => connector.startShapeId === upstreamShapeId && connector.endShapeId === downstreamShapeId
  );
  if (!exists) {
    createArrowBetweenShapes(editor, upstreamShapeId, downstreamShapeId);
  }
}

function deleteConnectorArrows(editor: Editor, upstreamShapeId: TLShapeId, downstreamShapeId: TLShapeId) {
  const arrowIds = getConnectorArrows(editor)
    .filter((connector) => connector.startShapeId === upstreamShapeId && connector.endShapeId === downstreamShapeId)
    .map((connector) => connector.arrowId);
  if (arrowIds.length > 0) {
    editor.deleteShapes(arrowIds);
  }
}

export function connectShapes(editor: Editor, upstreamShapeId: TLShapeId, downstreamShapeId: TLShapeId) {
  if (upstreamShapeId === downstreamShapeId) {
    throw new Error("A shape cannot connect to itself.");
  }

  const upstreamShape = editor.getShape(upstreamShapeId);
  const downstreamShape = editor.getShape(downstreamShapeId);
  if (!isConnectionShape(upstreamShape)) {
    throw new Error(`Shape ${upstreamShapeId} cannot have downstream connections.`);
  }
  if (!downstreamShape) {
    throw new Error(`Downstream shape ${downstreamShapeId} does not exist.`);
  }

  editor.run(() => {
    const downstreamShapeIds = addId(upstreamShape.props.downstreamShapeIds, downstreamShapeId);
    if (downstreamShapeIds !== upstreamShape.props.downstreamShapeIds) {
      updateConnectionProps(editor, upstreamShape, { downstreamShapeIds });
    }

    if (isConnectionShape(downstreamShape)) {
      const upstreamShapeIds = addId(downstreamShape.props.upstreamShapeIds, upstreamShapeId);
      if (upstreamShapeIds !== downstreamShape.props.upstreamShapeIds) {
        updateConnectionProps(editor, downstreamShape, { upstreamShapeIds });
      }
    }

    ensureConnectorArrow(editor, upstreamShapeId, downstreamShapeId);
  });
}

export function disconnectShapes(editor: Editor, upstreamShapeId: TLShapeId, downstreamShapeId: TLShapeId) {
  const upstreamShape = editor.getShape(upstreamShapeId);
  const downstreamShape = editor.getShape(downstreamShapeId);

  editor.run(() => {
    if (isConnectionShape(upstreamShape)) {
      updateConnectionProps(editor, upstreamShape, {
        downstreamShapeIds: removeId(upstreamShape.props.downstreamShapeIds, downstreamShapeId),
      });
    }
    if (isConnectionShape(downstreamShape)) {
      updateConnectionProps(editor, downstreamShape, {
        upstreamShapeIds: removeId(downstreamShape.props.upstreamShapeIds, upstreamShapeId),
      });
    }
    deleteConnectorArrows(editor, upstreamShapeId, downstreamShapeId);
  });
}

export function setShapeUpstreamConnections(editor: Editor, shapeId: TLShapeId, nextUpstreamShapeIds: TLShapeId[]) {
  const shape = editor.getShape(shapeId);
  if (!isConnectionShape(shape)) {
    throw new Error(`Shape ${shapeId} cannot have upstream connections.`);
  }

  const normalizedNextIds = Array.from(
    new Set(nextUpstreamShapeIds.filter((upstreamShapeId) => upstreamShapeId !== shapeId))
  );
  const recordedUpstreamIds = editor
    .getCurrentPageShapes()
    .filter(isConnectionShape)
    .filter((candidate) => candidate.props.downstreamShapeIds?.includes(shapeId))
    .map((candidate) => candidate.id);
  const connectorUpstreamIds = getConnectorArrows(editor)
    .filter((connector) => connector.endShapeId === shapeId && connector.startShapeId)
    .map((connector) => connector.startShapeId as TLShapeId);
  const currentIds = Array.from(
    new Set([
      ...(shape.props.upstreamShapeIds ?? []).map((upstreamShapeId) => upstreamShapeId as TLShapeId),
      ...recordedUpstreamIds,
      ...connectorUpstreamIds,
    ])
  );
  const nextIdSet = new Set(normalizedNextIds);

  editor.run(() => {
    for (const upstreamShapeId of currentIds) {
      if (!nextIdSet.has(upstreamShapeId)) {
        disconnectShapes(editor, upstreamShapeId, shapeId);
      }
    }
    for (const upstreamShapeId of normalizedNextIds) {
      connectShapes(editor, upstreamShapeId, shapeId);
    }

    const currentShape = editor.getShape(shapeId);
    if (isConnectionShape(currentShape)) {
      updateConnectionProps(editor, currentShape, { upstreamShapeIds: normalizedNextIds });
    }
  });
}

export function removeShapeFromConnections(editor: Editor, shapeId: TLShapeId) {
  editor.run(() => {
    for (const shape of editor.getCurrentPageShapes()) {
      if (!isConnectionShape(shape)) {
        continue;
      }

      const downstreamShapeIds = removeId(shape.props.downstreamShapeIds, shapeId);
      const upstreamShapeIds = removeId(shape.props.upstreamShapeIds, shapeId);
      if (
        downstreamShapeIds.length !== (shape.props.downstreamShapeIds ?? []).length ||
        upstreamShapeIds.length !== (shape.props.upstreamShapeIds ?? []).length
      ) {
        updateConnectionProps(editor, shape, { downstreamShapeIds, upstreamShapeIds });
      }
    }

    const staleArrowIds = getConnectorArrows(editor)
      .filter(
        (connector) =>
          connector.startShapeId === shapeId ||
          connector.endShapeId === shapeId ||
          !connector.startShapeId ||
          !connector.endShapeId
      )
      .map((connector) => connector.arrowId);
    if (staleArrowIds.length > 0) {
      editor.deleteShapes(staleArrowIds);
    }
  });
}
