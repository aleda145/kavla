import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, Check, GitBranch, Pause, Pencil, RotateCcw, X } from "lucide-react";
import { createShapeId, HTMLContainer, Rectangle2d, ShapeUtil, useEditor } from "tldraw";
import { explorationProps, type ExplorationPath, type ExplorationShape } from "./exploration-types";
import { updateExploration } from "./exploration-store";
import { getAgentLayout, getAgentPlacement } from "./agentLayout";
import createArrowBetweenShapes from "../util/CreateArrowBetweenShapes";
import { continueExploration } from "./continueExploration";
import { useData } from "../client/useLocalServer";
import { useAgentModels, useAgentStatus } from "../client/localServer/agentStore";
import { isAgentRunActive, useAgentRuns } from "../client/localServer/agentRuns";
import "./exploration.css";

function Action({
  label,
  icon,
  onClick,
  disabled = false,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} disabled={disabled}>
      {icon}
      <span className="kavla-control-label">{label}</span>
    </button>
  );
}

function ExplorationCard({ shape }: { shape: ExplorationShape }) {
  const editor = useEditor();
  const data = useData();
  const models = useAgentModels();
  const status = useAgentStatus();
  const runs = useAgentRuns();
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const props = shape.props;
  const open = props.status === "open";
  const chosen = props.paths.find((path) => path.id === props.chosenPathId);
  const active = runs.some(isAgentRunActive);
  const disabled = busy || active || shape.isLocked;
  const patch = (changes: Partial<ExplorationShape["props"]>) => updateExploration(editor, shape.id, changes);
  const changePath = (id: string, changes: Partial<ExplorationPath>) =>
    patch({ paths: props.paths.map((path) => (path.id === id ? { ...path, ...changes } : path)) });
  const choose = async (path: ExplorationPath) => {
    if (controller.current || disabled) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError("");
    try {
      await continueExploration(editor, shape.id, path, data, models.mainModel, abort.signal);
    } catch (cause) {
      if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      controller.current = null;
      setBusy(false);
    }
  };
  const reopen = () => {
    if (props.status === "chosen") {
      // Preserve the previous choice and its domain context when branching again.
      const id = createShapeId();
      const position = getAgentPlacement(editor, getAgentLayout({}, shape.id, "below"), shape.id, { w: 520, h: 680 });
      editor.run(() => {
        editor.createShape<ExplorationShape>({
          id,
          type: "exploration",
          x: position.x,
          y: position.y,
          props: {
            observation: props.observation,
            question: props.question,
            anchorShapeId: props.anchorShapeId,
            analystContext: props.analystContext,
            sourceRunId: props.sourceRunId,
            paths: props.paths.filter((path) => path.id !== "redirect"),
          },
        });
        createArrowBetweenShapes(editor, shape.id, id);
      });
      editor.select(id);
      editor.zoomToSelection({ animation: { duration: 200 } });
      return;
    }
    patch({ status: "open", h: 680, chosenPathId: "", queryShapeId: "", continuationRunId: "", continued: false });
    setError("");
  };
  return (
    <HTMLContainer id={shape.id} className={`kavla-exploration ${open ? "is-open" : "is-resolved"}`}>
      <header>
        <GitBranch size={17} />
        <strong>{open ? "Crossroads" : props.status === "parked" ? "Question parked" : "Direction chosen"}</strong>
        <span>{open ? "Your move" : "Investigation context"}</span>
      </header>
      <div
        className="exploration-body"
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <p className="exploration-observation">{props.observation}</p>
        {open ? (
          <>
            <h3>{props.question}</h3>
            <div className="exploration-paths">
              {props.paths
                .filter((path) => !path.rejected && path.id !== "redirect")
                .map((path) => (
                  <article key={path.id}>
                    <div className="exploration-path-heading">
                      <GitBranch size={15} />
                      <strong>{path.title}</strong>
                      <span>{path.sql ? "SQL · not run" : "Proposed path"}</span>
                    </div>
                    {editing === path.id ? (
                      <div className="exploration-edit">
                        <label>
                          Path name
                          <input
                            aria-label="Path name"
                            value={path.title}
                            maxLength={100}
                            disabled={disabled}
                            onChange={(event) => changePath(path.id, { title: event.target.value })}
                          />
                        </label>
                        <label>
                          What to investigate
                          <textarea
                            aria-label="What to investigate"
                            value={path.intent}
                            maxLength={500}
                            disabled={disabled}
                            onChange={(event) => changePath(path.id, { intent: event.target.value })}
                          />
                        </label>
                        {path.sourceShapeId && (
                          <label>
                            SQL to run
                            <textarea
                              className="exploration-sql"
                              aria-label="Proposed SQL"
                              value={path.sql}
                              spellCheck={false}
                              maxLength={24000}
                              disabled={disabled}
                              onChange={(event) => changePath(path.id, { sql: event.target.value })}
                            />
                          </label>
                        )}
                      </div>
                    ) : (
                      <>
                        <p>{path.intent}</p>
                        {path.sql && <pre title={path.sql}>{path.sql}</pre>}
                      </>
                    )}
                    <div className="exploration-actions">
                      <Action
                        label="Explore"
                        icon={<ArrowRight size={14} />}
                        disabled={disabled || status.state !== "ready"}
                        onClick={() => void choose(path)}
                      />
                      <Action
                        label={editing === path.id ? "Done editing" : "Edit"}
                        icon={<Pencil size={14} />}
                        disabled={disabled}
                        onClick={() => setEditing(editing === path.id ? null : path.id)}
                      />
                      <Action
                        label="Reject path"
                        icon={<X size={14} />}
                        disabled={disabled}
                        onClick={() => changePath(path.id, { rejected: true })}
                      />
                    </div>
                  </article>
                ))}
            </div>
            <label className="exploration-context">
              What should the agent know?
              <textarea
                aria-label="Domain context or a different direction"
                placeholder="E.g. this spike is expected — compare the following week instead…"
                value={props.analystContext}
                maxLength={4000}
                disabled={disabled}
                onChange={(event) => patch({ analystContext: event.target.value })}
              />
            </label>
            <div className="exploration-actions">
              <Action
                label="Follow my direction"
                icon={<ArrowRight size={14} />}
                disabled={disabled || status.state !== "ready" || !props.analystContext.trim()}
                onClick={() =>
                  void choose({
                    id: "redirect",
                    title: "Analyst direction",
                    intent: props.analystContext,
                    sourceShapeId: "",
                    sql: "",
                    rejected: false,
                  })
                }
              />
              <Action
                label="Park question"
                icon={<Pause size={14} />}
                disabled={disabled}
                onClick={() => patch({ status: "parked", h: 260 })}
              />
              {props.paths.some((path) => path.rejected) && (
                <Action
                  label="Restore paths"
                  icon={<RotateCcw size={14} />}
                  disabled={disabled}
                  onClick={() => patch({ paths: props.paths.map((path) => ({ ...path, rejected: false })) })}
                />
              )}
            </div>
          </>
        ) : (
          <>
            <h3>{props.status === "parked" ? props.question : chosen?.title}</h3>
            {chosen && <p>{chosen.intent}</p>}
            {props.analystContext && <p className="exploration-knowledge">{props.analystContext}</p>}
            <div className="exploration-actions">
              {chosen && !props.continued && (
                <Action
                  label="Continue"
                  icon={<ArrowRight size={14} />}
                  disabled={disabled || status.state !== "ready"}
                  onClick={() => void choose(chosen)}
                />
              )}
              {props.queryShapeId && (
                <Action
                  label="View query"
                  icon={<Check size={14} />}
                  onClick={() => {
                    const query = editor.getShape(props.queryShapeId as ExplorationShape["id"]);
                    if (query) {
                      editor.select(query.id);
                      editor.zoomToSelection({ animation: { duration: 200 } });
                    }
                  }}
                />
              )}
              <Action label="Revisit paths" icon={<GitBranch size={14} />} disabled={disabled} onClick={reopen} />
            </div>
          </>
        )}
        {busy && <p role="status">Running the chosen investigation…</p>}
        {active && open && <p role="status">The agent is finishing its current step.</p>}
        {status.state !== "ready" && open && (
          <p role="status">Set up the agent in chat to explore a path. Your edits are saved.</p>
        )}
        {error && (
          <p className="exploration-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </HTMLContainer>
  );
}

export class ExplorationUtil extends ShapeUtil<ExplorationShape> {
  static override type = "exploration" as const;
  static override props = explorationProps;
  getDefaultProps(): ExplorationShape["props"] {
    return {
      w: 520,
      h: 680,
      name: "Crossroads",
      anchorShapeId: "",
      observation: "",
      question: "",
      paths: [],
      status: "open",
      analystContext: "",
      chosenPathId: "",
      queryShapeId: "",
      sourceRunId: "",
      continuationRunId: "",
      continued: false,
    };
  }
  override canResize() {
    return false;
  }
  override hideRotateHandle() {
    return true;
  }
  getGeometry(shape: ExplorationShape) {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true });
  }
  component(shape: ExplorationShape) {
    return <ExplorationCard shape={shape} />;
  }
  indicator(shape: ExplorationShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={12} />;
  }
}
