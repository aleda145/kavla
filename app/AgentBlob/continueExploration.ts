import { createShapeId, type Editor, type TLShapeId } from "tldraw";
import type { ExplorationPath, ExplorationShape } from "./exploration-types";
import { updateExploration } from "./exploration-store";
import { agentClientId, agentRequest, getAgentRuns, isAgentRunActive } from "../client/localServer/agentRuns";
import { getActiveLocalSession, stageCanvas } from "../client/local/localSession";
import { appendAgentChatEntry, createOrFocusAgentChat, getAgentChat } from "./agent-chat-store";
import { hydratePromptCanvasContext } from "./agentCanvasTools";
import { randomUUID } from "../util/randomUUID";
import type { LocalServerContextType } from "../client/localServer/types";
import type { SQLTextAreaShape } from "../SQLTextArea/sql-text-area-types";
import { getAutoExpandedSQLShapeSize } from "../SQLTextArea/sqlShapeSize";
import { getUniqueName } from "../util/getUniqueName";
import { getAgentLayout, getAgentPlacement, reflowAgentQuery, trackAgentQueryLayout } from "./agentLayout";
import { connectShapes } from "../util/shapeConnections";
import createArrowBetweenShapes from "../util/CreateArrowBetweenShapes";
import { executeSQLShape } from "../SQLTextArea/executeSQLShape";

// The analyst's click executes the edited SQL through the same runner as a manual query.
// The following agent turn receives its result and the durable decision as context.
export async function continueExploration(
  editor: Editor,
  id: TLShapeId,
  path: ExplorationPath,
  data: LocalServerContextType,
  mainModel: string,
  signal: AbortSignal
) {
  let shape = editor.getShape<ExplorationShape>(id);
  if (!shape || shape.isLocked) throw new Error("This crossroads is unavailable or locked.");
  if (getAgentRuns().some(isAgentRunActive)) throw new Error("Wait for the current investigation to pause.");
  if (shape.props.continued) return;
  const documentId = getActiveLocalSession()?.documentId;
  if (!documentId) throw new Error("Open a document before continuing.");
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (getActiveLocalSession()?.documentId !== documentId || !editor.getShape(id))
      throw new Error("The investigation's document or crossroads has changed.");
  };
  const runId = shape.props.continuationRunId || randomUUID();
  // Retry a delivered request without repeating SQL or creating another branch.
  if (getAgentRuns().some((run) => run.id === runId)) {
    updateExploration(editor, id, { continued: true });
    return;
  }
  if (!path.title.trim() || !path.intent.trim())
    throw new Error("Give this path a title and an investigation direction.");
  if (shape.props.status !== "chosen") {
    updateExploration(editor, id, {
      status: "chosen",
      chosenPathId: path.id,
      continuationRunId: runId,
      h: 260,
      paths: shape.props.paths.some((item) => item.id === path.id) ? shape.props.paths : [...shape.props.paths, path],
    });
  }
  shape = editor.getShape<ExplorationShape>(id)!;
  let queryId = shape.props.queryShapeId as TLShapeId | "";
  if (path.sql.trim() && !queryId) {
    const source = editor.getShape(path.sourceShapeId as TLShapeId);
    if (!source || !["data-source", "sql-text-area"].includes(source.type))
      throw new Error("The proposed query's source was removed. Reopen the paths and choose another direction.");
    queryId = createShapeId();
    const size = getAutoExpandedSQLShapeSize(path.sql);
    const layout = getAgentLayout({ layout: { parentShapeId: id, placement: "right" } }, id, "right");
    const position = getAgentPlacement(editor, layout, id, size);
    editor.run(() => {
      editor.createShape<SQLTextAreaShape>({
        id: queryId as TLShapeId,
        type: "sql-text-area",
        x: position.x,
        y: position.y,
        props: { ...size, name: getUniqueName(editor, path.title), text: path.sql, showTable: true },
      });
      connectShapes(editor, source.id, queryId as TLShapeId);
      createArrowBetweenShapes(editor, id, queryId as TLShapeId);
      trackAgentQueryLayout(editor, queryId as TLShapeId, layout);
      updateExploration(editor, id, { queryShapeId: queryId });
    });
  }
  await stageCanvas(editor);
  assertCurrent();
  if (queryId) {
    const query = editor.getShape<SQLTextAreaShape>(queryId);
    if (!query) throw new Error("The chosen query was removed. Reopen the paths to start again.");
    if (!query.props.lastRunStats && !query.props.error) {
      // Keep failed SQL visible, and let the agent inspect and repair it after the handoff.
      try {
        await executeSQLShape(editor, data, queryId, query.props.text, signal);
      } catch (error) {
        assertCurrent();
        editor.updateShape<SQLTextAreaShape>({
          id: queryId,
          type: "sql-text-area",
          props: { error: error instanceof Error ? error.message : String(error), isDirty: true },
        });
      }
      assertCurrent();
      reflowAgentQuery(editor, queryId);
    }
  }
  createOrFocusAgentChat(editor);
  const chat = getAgentChat(editor);
  const text =
    `Continue from [Crossroads](${id}). I chose: ${path.title}.\nInvestigation: ${path.intent}\n` +
    `My domain context: ${shape.props.analystContext.trim() || "None added; do not infer domain facts."}\n` +
    (queryId
      ? `My edited SQL is in ${queryId}. Its execution was attempted; inspect its current result/error before continuing. Preserve my edits.\n`
      : "") +
    "Follow this direction only. Leave the other paths unexplored. Surface another crossroads when interpretation or priorities require my input; an unresolved question is a useful outcome.";
  const contextShapeIds = [id, shape.props.anchorShapeId, ...(queryId ? [queryId] : [])];
  const context = await hydratePromptCanvasContext(editor, data, contextShapeIds);
  assertCurrent();
  await stageCanvas(editor);
  assertCurrent();
  if (getAgentRuns().some(isAgentRunActive)) throw new Error("Another investigation started. Continue when it pauses.");
  await agentRequest(
    "prompts",
    {
      runId,
      clientId: agentClientId,
      documentId,
      prompt: text,
      mainModel,
      threadId: chat?.props.threadId ?? null,
      context,
      fallbackHistory: (chat?.props.entries ?? [])
        .filter((entry) => entry.role !== "thought")
        .slice(-30)
        .map((entry) => `${entry.role}: ${entry.text}`)
        .join("\n\n")
        .slice(-24000),
    },
    signal
  );
  assertCurrent();
  updateExploration(editor, id, { continued: true });
  if (!getAgentChat(editor)?.props.entries.some((entry) => entry.runId === runId && entry.role === "user"))
    appendAgentChatEntry(editor, { role: "user", runId, text, contextShapeIds });
  await stageCanvas(editor);
}
