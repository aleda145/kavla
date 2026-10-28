import { getArrowBindings, type Editor, type TLArrowShape, type TLShape, type TLShapeId } from "tldraw";
import type { DataSourceShape } from "../DataSource/data-source-types";
import type { SQLTextAreaShape } from "../SQLTextArea/sql-text-area-types";
import type { DbtMacroShape } from "../Dbt/dbtTypes";
import { getDbtMacroInputs } from "../Dbt/dbtMacros";
import type { KnobShape } from "../Knob/knob-types";
import createArrowBetweenShapes from "./CreateArrowBetweenShapes";

type ConnectionShape = DataSourceShape | SQLTextAreaShape | KnobShape | DbtMacroShape;
type ConnectionProps = Pick<ConnectionShape["props"], "downstreamShapeIds" | "upstreamShapeIds">;

interface ConnectorArrow {
  arrowId: TLShapeId;
  startShapeId: TLShapeId | null;
  endShapeId: TLShapeId | null;
}

function isConnectionShape(shape: TLShape | undefined): shape is ConnectionShape {
  return (
    shape?.type === "data-source" ||
    shape?.type === "sql-text-area" ||
    shape?.type === "knob" ||
    shape?.type === "dbt-macro"
  );
}

function updateConnectionProps(editor: Editor, shape: ConnectionShape, props: Partial<ConnectionProps>) {
  if (shape.type === "dbt-macro") {
    editor.updateShape<DbtMacroShape>({ id: shape.id, type: "dbt-macro", props });
    return;
  }
  if (shape.type === "knob") {
    editor.updateShape<KnobShape>({ id: shape.id, type: "knob", props });
    return;
  }
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
  const existing = getConnectorArrows(editor).find(
    (connector) => connector.startShapeId === upstreamShapeId && connector.endShapeId === downstreamShapeId
  );
  if (!existing) {
    createArrowBetweenShapes(editor, upstreamShapeId, downstreamShapeId);
  } else if (editor.getShape(upstreamShapeId)?.type === "dbt-macro") {
    const arrow = editor.getShape<TLArrowShape>(existing.arrowId);
    if (arrow?.props.color === "orange") {
      editor.updateShape<TLArrowShape>({ id: arrow.id, type: "arrow", props: { color: "black" } });
    }
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
  if (
    downstreamShape.type === "dbt-macro" ||
    (upstreamShape.type === "dbt-macro" && downstreamShape.type !== "sql-text-area")
  ) {
    throw new Error("Macros can only connect to SQL queries, as inputs.");
  }
  if (downstreamShape.type === "knob" || (upstreamShape.type === "knob" && downstreamShape.type !== "sql-text-area")) {
    throw new Error("Knobs can only connect to SQL queries, as inputs.");
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

  if (shape.type === "sql-text-area")
    nextUpstreamShapeIds = [...nextUpstreamShapeIds, ...getDbtMacroInputs(editor, shape.props.text)];
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
      const previous = currentShape.props.upstreamShapeIds ?? [];
      if (
        previous.length !== normalizedNextIds.length ||
        previous.some((id, index) => id !== normalizedNextIds[index])
      ) {
        updateConnectionProps(editor, currentShape, { upstreamShapeIds: normalizedNextIds });
      }
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
