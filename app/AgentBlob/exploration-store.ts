import { createShapeId, type Editor, type TLShapeId } from "tldraw";
import type { ExplorationPath, ExplorationShape } from "./exploration-types";
import { getAgentLayout, getAgentPlacement } from "./agentLayout";
import createArrowBetweenShapes from "../util/CreateArrowBetweenShapes";
import { resolveAgentDataShape } from "./agentDataTools";

export function updateExploration(editor: Editor, id: TLShapeId, props: Partial<ExplorationShape["props"]>) {
  editor.updateShape<ExplorationShape>({ id, type: "exploration", props });
}

export function getExplorations(editor: Editor): ExplorationShape[] {
  return editor.getCurrentPageShapes().filter((shape): shape is ExplorationShape => shape.type === "exploration");
}

export function describeExploration(shape: ExplorationShape) {
  const { observation, question, status, analystContext, chosenPathId, queryShapeId, paths, anchorShapeId } =
    shape.props;
  return {
    id: shape.id,
    type: "exploration",
    anchorShapeId,
    observation,
    question,
    status,
    analystContext,
    chosenPathId,
    queryShapeId,
    paths,
  };
}

export function proposeExploration(editor: Editor, args: Record<string, unknown>, runId: string) {
  const string = (value: unknown, name: string, max: number) => {
    if (typeof value !== "string" || !value.trim() || value.length > max)
      throw new Error(`${name} must contain between 1 and ${max} characters.`);
    return value.trim();
  };
  const anchorShapeId = string(args.anchorShapeId, "anchorShapeId", 200) as TLShapeId;
  if (!editor.getShape(anchorShapeId)) throw new Error("The crossroads needs an existing evidence shape.");
  const observation = string(args.observation, "observation", 800);
  const question = string(args.question, "question", 300);
  if (!Array.isArray(args.paths) || args.paths.length < 2 || args.paths.length > 3)
    throw new Error("Propose two or three distinct investigations.");
  const paths: ExplorationPath[] = args.paths.map((raw: unknown, index) => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid investigation path.");
    const path = raw as Record<string, unknown>;
    if (path.sql !== undefined && typeof path.sql !== "string") throw new Error("Proposed SQL must be text.");
    const sql = typeof path.sql === "string" ? path.sql.trim() : "";
    if (sql.length > 24000) throw new Error("Proposed SQL is too long.");
    const source = sql ? resolveAgentDataShape(editor, string(path.sourceShapeId, "sourceShapeId", 200)) : null;
    return {
      id: `path-${index + 1}`,
      title: string(path.title, "title", 100),
      intent: string(path.intent, "intent", 500),
      sourceShapeId: source?.id ?? "",
      sql,
      rejected: false,
    };
  });
  const size = { w: 520, h: 680 };
  const position = getAgentPlacement(editor, getAgentLayout(args, anchorShapeId, "below"), anchorShapeId, size);
  const id = createShapeId();
  editor.run(() => {
    editor.createShape<ExplorationShape>({
      id,
      type: "exploration",
      x: position.x,
      y: position.y,
      props: { ...size, anchorShapeId, observation, question, paths, sourceRunId: runId },
    });
    createArrowBetweenShapes(editor, anchorShapeId, id);
  });
  return {
    ok: true,
    shapeId: id,
    awaitingDecision: true,
    message:
      "Investigation paused at a crossroads. No proposed SQL has executed. The analyst will choose, edit, redirect, or park it.",
  };
}
