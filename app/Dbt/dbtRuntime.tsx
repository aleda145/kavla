import { useEffect } from "react";
import { createShapeId, useEditor, type Editor, type TLArrowBinding, type TLArrowShape, type TLShapeId } from "tldraw";
import { sessionFetch } from "../client/backendCompute";
import { getCanvasConnection } from "../client/canvasConnection";
import { dbtFileView, updateDbtFile, dbtRelation, isDbtMetadataFile, getDbtHiddenDrafts } from "./dbtCanvas";
import type { SQLTextAreaShape } from "../SQLTextArea/sql-text-area-types";
import type { DataSourceShape } from "../DataSource/data-source-types";
import { getDbtMacroInputs } from "./dbtMacros";
import { getSQLKnobs } from "../Knob/knobSQL";
import { getUniqueName } from "../util/getUniqueName";
import { setShapeUpstreamConnections } from "../util/shapeConnections";
import { getOrderedDependenciesForSQL } from "../SQLTextArea/sqlDependencies";
import { rememberUploadedBlob, type KavlaBlobDescriptor } from "../client/local/localSession";
import { getCliSourcesSnapshot } from "../client/useLocalServer";
import type { DbtFile, DbtFileShape, DbtMacroShape, DbtFileView, DbtIssue, DbtProject } from "./dbtTypes";

import { dbtState } from "./dbtState";
export { dbtState } from "./dbtState";

function publish(update: Partial<ReturnType<typeof dbtState.get>>) {
  dbtState.set({ ...dbtState.get(), ...update });
}

async function request<T>(method = "GET", body?: unknown, suffix = ""): Promise<T> {
  const response = await sessionFetch(`/api/dbt${suffix}`, {
    method,
    cache: "no-store",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error || text;
    } catch {
      /* Plain HTTP errors are also supported. */
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export function dbtShapes(editor: Editor): DbtFileView[] {
  return editor.getCurrentPageShapes().flatMap((shape) => {
    const file = dbtFileView(shape);
    return file ? [file] : [];
  });
}

const controllers = new WeakMap<Editor, DbtController>();
export function dbtController(editor: Editor): DbtController {
  const controller = controllers.get(editor);
  if (!controller) throw new Error("dbt is still opening. Try again in a moment.");
  return controller;
}

export async function flushDbt(editor: Editor | null): Promise<void> {
  if (editor) await controllers.get(editor)?.flush();
}

export class DbtController {
  private queue: Promise<unknown> = Promise.resolve();
  private syncing = false;
  private stopped = false;
  private lastEdit = new Map<string, number>();
  private failedWrites = new Map<string, string>();
  private timer: ReturnType<typeof setInterval>;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private unlisten: () => void;
  private allowSyncMetadataChange = false;
  private unregisterMetadataGuard: () => void;

  constructor(private editor: Editor) {
    publish({ project: null, error: "", busy: false, paused: false, lastSync: null, issues: {} });
    // Undo restores entire shape records. Keep the last acknowledged disk
    // revision when undoing a text edit, so the undone text is saved as an edit
    // rather than being mistaken for an old, clean copy of the file.
    this.unregisterMetadataGuard = editor.sideEffects.registerBeforeChangeHandler("shape", (previous, next) => {
      if (this.allowSyncMetadataChange || editor.getInstanceState().isReadonly) return next;
      const before = dbtFileView(previous);
      const after = dbtFileView(next);
      if (!before || !after) return next;
      if (
        before.props.bindingId !== after.props.bindingId ||
        before.props.projectRoot !== after.props.projectRoot ||
        before.props.path !== after.props.path
      )
        return next;
      if (next.type === "sql-text-area") {
        const query = next as SQLTextAreaShape;
        return {
          ...query,
          props: {
            ...query.props,
            dbt: {
              ...query.props.dbt!,
              baseText: before.props.baseText,
              revision: before.props.revision,
              readOnly: before.props.readOnly,
            },
          },
        };
      }
      return {
        ...next,
        props: {
          ...next.props,
          baseText: before.props.baseText,
          revision: before.props.revision,
          readOnly: before.props.readOnly,
        },
      };
    });
    this.unlisten = editor.store.listen(
      ({ changes }) => {
        const changedInputs = new Set<string>();
        let changedMacros = false;
        for (const [before, after] of Object.values(changes.updated)) {
          if (before.typeName === "shape" && after.typeName === "shape") {
            if (
              before.type === "sql-text-area" &&
              after.type === "sql-text-area" &&
              (before as SQLTextAreaShape).props.text !== (after as SQLTextAreaShape).props.text
            )
              changedInputs.add(after.id);
            if (
              before.type === "data-source" &&
              after.type === "data-source" &&
              (before as DataSourceShape).props.remoteTableRef !== (after as DataSourceShape).props.remoteTableRef
            )
              changedInputs.add(after.id);
            const file = dbtFileView(after),
              oldFile = dbtFileView(before);
            if (
              file &&
              oldFile &&
              file.props.text !== oldFile.props.text &&
              (file.props.kind === "macro" || file.props.path === "dbt_project.yml")
            ) {
              changedMacros = true;
              changedInputs.add(after.id);
            }
          }
          if (before.typeName === "shape" && after.typeName === "shape" && dbtFileView(before) && dbtFileView(after)) {
            if ((before as DbtFileShape).props.text !== (after as DbtFileShape).props.text)
              this.lastEdit.set(after.id, Date.now());
          }
        }
        if (changedInputs.size || changedMacros) {
          for (const query of this.editor
            .getCurrentPageShapes()
            .filter((shape): shape is SQLTextAreaShape => shape.type === "sql-text-area")) {
            const deps = getOrderedDependenciesForSQL(this.editor, query.props.text).orderedDependencies;
            // Keep the last resolved macro edges useful for invalidation after an
            // edit has invalidated the compilation cache.
            const previousInputs = new Set<string>();
            const visit = (id: string) => {
              if (previousInputs.has(id)) return;
              previousInputs.add(id);
              const shape = this.editor.getShape(id as TLShapeId);
              if (shape?.type === "sql-text-area")
                for (const upstream of (shape as SQLTextAreaShape).props.upstreamShapeIds ?? []) visit(upstream);
            };
            for (const id of query.props.upstreamShapeIds ?? []) visit(id);
            if (
              (changedMacros &&
                (getDbtMacroInputs(this.editor, query.props.text).some((id) => changedInputs.has(id)) ||
                  deps.some(
                    (shape) =>
                      shape.type === "sql-text-area" &&
                      getDbtMacroInputs(this.editor, shape.props.text).some((id) => changedInputs.has(id))
                  ))) ||
              deps.some((shape) => changedInputs.has(shape.id)) ||
              [...previousInputs].some((id) => changedInputs.has(id))
            ) {
              if (!query.props.stale || !query.props.isDirty)
                this.editor.updateShape<SQLTextAreaShape>({
                  id: query.id,
                  type: query.type,
                  props: { stale: true, isDirty: true },
                });
            }
          }
          this.refreshSQLConnections();
        }
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => void this.sync(), 800);
      },
      { scope: "document", source: "user" }
    );
    this.timer = setInterval(() => void this.sync(), 2000);
    void this.sync();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.idleTimer);
    this.unlisten();
    this.unregisterMetadataGuard();
  }

  private active() {
    return (
      !this.stopped &&
      !this.editor.isDisposed &&
      !this.editor.getInstanceState().isReadonly &&
      getCanvasConnection().status === "ready"
    );
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }

  connect(path: string, sourceName = "") {
    return this.enqueue(async () => {
      if (!this.active()) throw new Error("Wait for the canvas to reconnect.");
      publish({ busy: true, error: "" });
      try {
        const project = await request<DbtProject>("PUT", { path, sourceName });
        if (!this.active() || !project.binding) return;
        // Explicitly connecting authorizes reattaching saved drafts at this root.
        const priorBindings = new Set<string>();
        for (const shape of dbtShapes(this.editor)) {
          if (shape.props.bindingId && shape.props.projectRoot === project.binding.root) {
            priorBindings.add(shape.props.bindingId);
            updateDbtFile(this.editor, shape, { bindingId: project.binding.id });
          }
        }
        for (const shape of this.editor.getCurrentPageShapes()) {
          const relation = dbtRelation(shape);
          if (
            shape.type === "data-source" &&
            relation &&
            (priorBindings.has(relation.bindingId) || relation.projectRoot === project.binding.root)
          )
            this.editor.updateShape<DataSourceShape>({
              id: shape.id,
              type: "data-source",
              meta: {
                ...shape.meta,
                dbtRelation: { ...relation, bindingId: project.binding.id, projectName: project.name },
              },
            });
        }
        publish({ project, paused: false, issues: {} });
        this.failedWrites.clear();
        await this.reconcile(project, false);
        this.focus();
      } finally {
        publish({ busy: false });
      }
    });
  }

  disconnect() {
    return this.enqueue(async () => {
      if (!this.active()) throw new Error("Wait for the canvas to reconnect.");
      await request<DbtProject>("DELETE");
      publish({ project: null, issues: {}, error: "", paused: false, lastSync: null });
    });
  }

  pause(paused: boolean) {
    publish({ paused });
    if (!paused) void this.sync(true);
  }

  async flush() {
    await this.queue;
    if (!dbtState.get().paused) await this.sync(true);
  }

  focus() {
    const binding = dbtState.get().project?.binding;
    if (!binding) return;
    const shapes = this.editor
      .getCurrentPageShapes()
      .filter(
        (shape) => dbtFileView(shape)?.props.bindingId === binding.id || dbtRelation(shape)?.bindingId === binding.id
      );
    if (shapes.length) {
      this.editor.select(...shapes.map((shape) => shape.id));
      this.editor.zoomToSelection({ animation: { duration: 250 } });
    }
  }

  sync(force = false): Promise<void> {
    if (this.syncing) return this.queue.then(() => {});
    if (!this.active() || (dbtState.get().paused && !force)) return Promise.resolve();
    this.syncing = true;
    return this.enqueue(async () => {
      if (!this.active() || (dbtState.get().paused && !force)) return;
      publish({ busy: true });
      try {
        this.removeMetadataCards();
        const previousConfig = dbtState.get().project?.files.find((file) => file.path === "dbt_project.yml")?.text;
        const project = await request<DbtProject>();
        if (!this.active()) return;
        publish({ project, error: "" });
        if (
          previousConfig !== undefined &&
          previousConfig !== project.files.find((file) => file.path === "dbt_project.yml")?.text
        ) {
          for (const shape of this.editor.getCurrentPageShapes()) {
            if (shape.type !== "sql-text-area") continue;
            const query = shape as SQLTextAreaShape;
            if (
              query.props.dbt ||
              getOrderedDependenciesForSQL(this.editor, query.props.text).orderedDependencies.some(
                (input) => input.type === "sql-text-area" && input.props.dbt
              )
            ) {
              this.editor.updateShape<SQLTextAreaShape>({
                id: query.id,
                type: query.type,
                props: { isDirty: true, stale: true },
              });
            }
          }
        }
        if (force) this.failedWrites.clear();
        await this.reconcile(project, true, force);
        if (this.active()) publish({ lastSync: Date.now() });
      } catch (error) {
        if (!this.stopped) publish({ error: error instanceof Error ? error.message : String(error) });
      } finally {
        if (!this.stopped) publish({ busy: false });
      }
    }).finally(() => {
      this.syncing = false;
    });
  }

  private update(shape: DbtFileView, props: Partial<DbtFileShape["props"]>) {
    if (Object.entries(props).some(([key, value]) => shape.props[key as keyof DbtFileShape["props"]] !== value)) {
      this.allowSyncMetadataChange = true;
      try {
        this.editor.run(() => updateDbtFile(this.editor, shape, props), { history: "ignore" });
      } finally {
        this.allowSyncMetadataChange = false;
      }
    }
  }

  private async write(shape: DbtFileView, disk: DbtFile): Promise<void> {
    const text = shape.props.text;
    const saved = await request<DbtFile>(
      "PUT",
      { bindingId: shape.props.bindingId, path: shape.props.path, revision: disk.revision, text },
      "/file"
    );
    if (!this.active()) return;
    const current = dbtFileView(this.editor.getShape(shape.id));
    // A keystroke arriving during the request stays dirty for the next pass.
    if (current?.props.bindingId === shape.props.bindingId && current.props.path === shape.props.path) {
      this.update(current, { baseText: text, revision: saved.revision });
    }
  }

  private async reconcile(project: DbtProject, write: boolean, force = false) {
    this.removeMetadataCards();
    const binding = project.binding;
    if (!binding) {
      publish({ issues: {} });
      return;
    }
    const issues: Record<string, DbtIssue> = {};
    const files = new Map(project.files.map((file) => [file.path, file]));
    const shapes = dbtShapes(this.editor).filter(
      (shape) => shape.props.bindingId === binding.id && shape.props.projectRoot === binding.root
    );
    const counts = new Map<string, number>();
    for (const shape of shapes) counts.set(shape.props.path, (counts.get(shape.props.path) ?? 0) + 1);
    for (const file of shapes) {
      const query = this.editor.getShape<SQLTextAreaShape>(file.id);
      if (query?.type === "sql-text-area" && query.props.dbt && query.props.dbt.projectName !== project.name)
        this.editor.updateShape<SQLTextAreaShape>({
          id: query.id,
          type: "sql-text-area",
          props: { dbt: { ...query.props.dbt, projectName: project.name } },
        });
    }
    this.upgradeModels(project);
    this.upgradeMacros();
    this.importFiles(project, new Set(shapes.map((shape) => shape.props.path)));
    Object.assign(issues, await this.ensureRelations(project));
    this.enrichNodes(project);
    for (const original of shapes) {
      if (!this.active() || (dbtState.get().paused && !force)) return;
      const shape = dbtFileView(this.editor.getShape(original.id));
      if (!shape) continue;
      const p = shape.props;
      const file = files.get(p.path);
      if (counts.get(p.path)! > 1) {
        issues[shape.id] = {
          kind: "duplicate",
          message: "Multiple nodes link to this file. Keep one linked node; detach the others.",
        };
      } else if (!file) {
        issues[shape.id] = {
          kind: "missing",
          message: "File removed, renamed, or outside the project paths. Your canvas copy is kept.",
        };
      } else if (p.text === file.text) {
        this.update(shape, { baseText: file.text, revision: file.revision, readOnly: file.readOnly });
      } else if (p.text === p.baseText) {
        this.update(shape, {
          text: file.text,
          baseText: file.text,
          revision: file.revision,
          readOnly: file.readOnly,
          kind: file.kind,
        });
      } else if (file.text !== p.baseText) {
        issues[shape.id] = {
          kind: "conflict",
          message: "Changed on canvas and disk. Review both versions.",
          disk: file,
        };
      } else if (file.readOnly) {
        issues[shape.id] = { kind: "error", message: "This file is now a read-only preview. Your draft is kept." };
      } else if (write && (force || Date.now() - (this.lastEdit.get(shape.id) ?? 0) >= 700)) {
        const failedKey = JSON.stringify([p.text, file.revision]);
        if (this.failedWrites.get(shape.id) === failedKey) {
          const previous = dbtState.get().issues[shape.id];
          if (previous) issues[shape.id] = previous;
          continue;
        }
        try {
          await this.write(shape, file);
          this.failedWrites.delete(shape.id);
        } catch (error) {
          this.failedWrites.set(shape.id, failedKey);
          issues[shape.id] = { kind: "error", message: error instanceof Error ? error.message : String(error) };
        }
      }
    }
    if (!this.active()) return;
    this.lineage(project);
    this.refreshSQLConnections();
    publish({ issues });
  }

  private refreshSQLConnections() {
    if (!dbtState.get().project?.binding) return;
    for (const query of this.editor
      .getCurrentPageShapes()
      .filter((shape): shape is SQLTextAreaShape => shape.type === "sql-text-area")) {
      const upstream = getOrderedDependenciesForSQL(this.editor, query.props.text).immediateUpstreamIds;
      if (!upstream.includes(query.id))
        setShapeUpstreamConnections(this.editor, query.id, [
          ...upstream,
          ...getSQLKnobs(this.editor, query.props.text).map((knob) => knob.id),
        ]);
    }
  }

  private removeMetadataCards() {
    const cards = dbtShapes(this.editor).filter(
      (shape) => shape.type === "dbt-file" && (isDbtMetadataFile(shape.props.path) || shape.props.kind === "seed")
    );
    if (!cards.length) return;
    this.editor.run(
      () => {
        const drafts = getDbtHiddenDrafts(this.editor);
        for (const card of cards) {
          if (
            card.props.text !== card.props.baseText &&
            !drafts.some((draft) => draft.id === card.id && draft.text === card.props.text)
          ) {
            drafts.push({
              id: card.id,
              path: card.props.path,
              text: card.props.text,
              projectRoot: card.props.projectRoot,
            });
          }
        }
        if (drafts.length) {
          const page = this.editor.getCurrentPage();
          this.editor.updatePage({ id: page.id, meta: { ...page.meta, dbtHiddenDrafts: drafts } });
        }
        for (const shape of this.editor.getCurrentPageShapes()) {
          if (shape.type !== "data-source") continue;
          const relation = dbtRelation(shape);
          const card = cards.find(
            (file) => relation?.bindingId === file.props.bindingId && relation?.path === file.props.path
          );
          if (relation && card && !relation.projectRoot)
            this.editor.updateShape<DataSourceShape>({
              id: shape.id,
              type: "data-source",
              meta: { ...shape.meta, dbtRelation: { ...relation, projectRoot: card.props.projectRoot } },
            });
        }
        const ids = new Set(cards.map((card) => card.id));
        const arrows = this.editor
          .getCurrentPageShapes()
          .filter(
            (shape) =>
              shape.type === "arrow" &&
              typeof shape.meta.dbtEdge === "string" &&
              cards.some((card) => String(shape.meta.dbtEdge).includes(card.id))
          );
        this.editor.deleteShapes([...ids, ...arrows.map((shape) => shape.id)]);
      },
      { history: "ignore" }
    );
  }

  private enrichNodes(project: DbtProject) {
    for (const shape of this.editor.getCurrentPageShapes()) {
      if (shape.type !== "sql-text-area" && shape.type !== "data-source") continue;
      const relation = dbtRelation(shape);
      if (!relation || relation.bindingId !== project.binding?.id) continue;
      const kind =
        shape.type === "sql-text-area"
          ? (shape as SQLTextAreaShape).props.dbt?.kind
          : relation.source
            ? "source"
            : "seed";
      const documentation =
        project.documentation?.find(
          (doc) =>
            doc.kind === kind &&
            (relation.source
              ? doc.source === relation.source && doc.name === relation.table
              : doc.name === relation.refName)
        ) ?? null;
      if (JSON.stringify(shape.meta.dbtDocumentation ?? null) !== JSON.stringify(documentation)) {
        this.editor.updateShape({
          id: shape.id,
          type: shape.type,
          meta: { ...shape.meta, dbtDocumentation: documentation },
        });
      }
    }
  }

  private modelName(path: string) {
    return path
      .split("/")
      .pop()!
      .replace(/\.[^.]+$/, "");
  }

  private isSQLModel(file: Pick<DbtFile, "path" | "kind" | "readOnly">) {
    return !file.readOnly && file.path.endsWith(".sql") && ["model", "analysis", "test"].includes(file.kind);
  }

  private upgradeModels(project: DbtProject) {
    for (const file of dbtShapes(this.editor)) {
      if (file.type !== "dbt-file" || file.props.bindingId !== project.binding?.id || !this.isSQLModel(file.props))
        continue;
      const { text, w, h, ...link } = file.props;
      const defaults = this.editor.getShapeUtil<SQLTextAreaShape>("sql-text-area").getDefaultProps();
      // Keep IDs and bindings so existing canvases retain their positions and
      // annotations. Shape-type replacement must not invoke SQL update hooks
      // with the legacy file card's properties.
      this.editor.store.applyDiff(
        {
          added: {},
          removed: {},
          updated: {
            [file.id]: [
              this.editor.getShape(file.id)!,
              {
                ...file,
                type: "sql-text-area",
                props: {
                  ...defaults,
                  text,
                  w,
                  h,
                  name: getUniqueName(this.editor, this.modelName(file.props.path)),
                  isDirty: true,
                  isManuallyResized: true,
                  dbt: { ...link, projectName: project.name, refName: this.modelName(file.props.path) },
                },
              } as SQLTextAreaShape,
            ],
          },
        },
        { runCallbacks: false }
      );
    }
  }

  private upgradeMacros() {
    for (const file of dbtShapes(this.editor)) {
      if (file.type !== "dbt-file" || file.props.kind !== "macro" || !file.props.path.endsWith(".sql")) continue;
      this.editor.store.applyDiff(
        {
          added: {},
          removed: {},
          updated: {
            [file.id]: [
              this.editor.getShape(file.id)!,
              {
                ...file,
                type: "dbt-macro",
                props: {
                  ...file.props,
                  name: this.modelName(file.props.path),
                  upstreamShapeIds: [],
                  downstreamShapeIds: [],
                },
              } as DbtMacroShape,
            ],
          },
        },
        { runCallbacks: false }
      );
    }
  }

  private async ensureRelations(project: DbtProject): Promise<Record<string, DbtIssue>> {
    const binding = project.binding!;
    const issues: Record<string, DbtIssue> = {};
    const relations = this.editor
      .getCurrentPageShapes()
      .filter(
        (shape): shape is DataSourceShape =>
          shape.type === "data-source" && dbtRelation(shape)?.bindingId === binding.id
      );
    const bounds = this.editor.getCurrentPageBounds();
    let row = 0;
    for (const file of project.files.filter((file) => file.kind === "seed" && file.path.endsWith(".csv"))) {
      if (!this.active()) break;
      const existing = relations.find((shape) => dbtRelation(shape)?.path === file.path);
      if (existing && dbtRelation(existing)?.revision === file.revision && existing.props.remoteTableRef) continue;
      const id = existing?.id ?? createShapeId();
      if (!existing)
        this.editor.createShape<DataSourceShape>({
          id,
          type: "data-source",
          x: (bounds?.minX ?? 0) - 550,
          y: (bounds?.minY ?? 0) + row++ * 560,
          props: { name: getUniqueName(this.editor, this.modelName(file.path)), filename: file.path, isRunning: true },
          meta: {
            dbtRelation: {
              bindingId: binding.id,
              projectRoot: binding.root,
              projectName: project.name,
              refName: this.modelName(file.path),
              path: file.path,
            },
          },
        });
      try {
        const seed = await request<{
          tableRef: string;
          schema: { name: string; type: string }[];
          rowCount: number;
          blob: KavlaBlobDescriptor;
        }>("POST", { bindingId: binding.id, path: file.path }, "/seed");
        if (!this.active()) break;
        rememberUploadedBlob(seed.blob);
        const current = this.editor.getShape<DataSourceShape>(id);
        if (!current) continue;
        const props = {
          name: current.props.name,
          isRunning: false,
          filename: file.path,
          sourceName: "uploaded_files",
          sourceType: "duckdb",
          remoteTableRef: seed.tableRef,
          metadata: seed.schema,
          rowCount: seed.rowCount,
          fileSize: seed.blob.size,
          error: null,
        };
        const meta = {
          ...current.meta,
          dbtRelation: {
            bindingId: binding.id,
            projectRoot: binding.root,
            projectName: project.name,
            refName: this.modelName(file.path),
            path: file.path,
            revision: file.revision,
          },
        };
        this.editor.updateShape<DataSourceShape>({ id, type: "data-source", props, meta });
      } catch (error) {
        const message = `Seed import: ${error instanceof Error ? error.message : String(error)}`;
        issues[id] = { kind: "error", message };
        if (this.active() && this.editor.getShape(id))
          this.editor.updateShape<DataSourceShape>({
            id,
            type: "data-source",
            props: { error: message, isRunning: false },
          });
      }
    }
    const connection = getCliSourcesSnapshot().find((source) => source.name === binding.sourceName);
    for (const source of project.sources ?? []) {
      const existing = relations.find((shape) => {
        const relation = dbtRelation(shape);
        return relation?.source === source.source && relation.table === source.table;
      });
      const tableRef = connection ? `${connection.name}.${source.schema}.${source.identifier}` : null;
      if (
        existing &&
        existing.props.sourceName === (connection?.name ?? null) &&
        existing.props.remoteTableRef === tableRef
      )
        continue;
      const id = existing?.id ?? createShapeId();
      const props = {
        name: existing?.props.name ?? getUniqueName(this.editor, `${source.source}_${source.table}`),
        filename: source.identifier,
        sourceName: connection?.name ?? null,
        sourceType: connection?.type ?? null,
        remoteTableRef: tableRef,
        metadata: null,
        rowCount: null,
        error: connection ? null : "Choose a warehouse connection in dbt settings to query this source.",
      };
      const meta = {
        ...(existing?.meta ?? {}),
        dbtRelation: {
          bindingId: binding.id,
          projectRoot: binding.root,
          projectName: project.name,
          refName: `${source.source}.${source.table}`,
          source: source.source,
          table: source.table,
          path: source.path,
        },
      };
      if (existing) this.editor.updateShape<DataSourceShape>({ id, type: "data-source", props, meta });
      else
        this.editor.createShape<DataSourceShape>({
          id,
          type: "data-source",
          x: (bounds?.minX ?? 0) - 550,
          y: (bounds?.minY ?? 0) + row++ * 560,
          props,
          meta,
        });
    }
    return issues;
  }

  private importFiles(project: DbtProject, existing: Set<string>) {
    const binding = project.binding!;
    const missing = project.files.filter(
      (file) => !isDbtMetadataFile(file.path) && file.kind !== "seed" && !existing.has(file.path)
    );
    if (!missing.length) return;
    const bounds = this.editor.getCurrentPageBounds();
    const origin = bounds ? { x: bounds.maxX + 160, y: bounds.minY } : this.editor.getViewportPageBounds().center;
    const levels = new Map<string, number>();
    const files = new Map(project.files.map((file) => [file.path, file]));
    const visiting = new Set<string>();
    const depth = (name: string): number => {
      if (levels.has(name)) return levels.get(name)!;
      if (visiting.has(name)) return 0;
      visiting.add(name);
      const level = Math.min(20, Math.max(-1, ...(files.get(name)?.dependsOn ?? []).map(depth)) + 1);
      visiting.delete(name);
      levels.set(name, level);
      return level;
    };
    const rows = new Map<number, number>();
    this.editor.run(
      () => {
        for (const file of missing) {
          const level = depth(file.path);
          const row = rows.get(level) ?? 0;
          rows.set(level, row + 1);
          const props = {
            w: 560,
            h: 340,
            bindingId: binding.id,
            projectRoot: binding.root,
            path: file.path,
            kind: file.kind,
            text: file.text,
            baseText: file.text,
            revision: file.revision,
            readOnly: file.readOnly,
          };
          if (file.kind === "macro" && file.path.endsWith(".sql")) {
            this.editor.createShape<DbtMacroShape>({
              id: createShapeId(),
              type: "dbt-macro",
              x: origin.x + level * 700,
              y: origin.y + row * 540,
              props: { ...props, name: this.modelName(file.path) },
            });
          } else if (this.isSQLModel(file)) {
            const { text, w, h, ...link } = props;
            this.editor.createShape<SQLTextAreaShape>({
              id: createShapeId(),
              type: "sql-text-area",
              x: origin.x + level * 700,
              y: origin.y + row * 540,
              props: {
                text,
                w,
                h,
                name: getUniqueName(this.editor, this.modelName(file.path)),
                isDirty: true,
                isManuallyResized: true,
                dbt: { ...link, projectName: project.name, refName: this.modelName(file.path) },
              },
            });
          } else {
            this.editor.createShape<DbtFileShape>({
              id: createShapeId(),
              type: "dbt-file",
              x: origin.x + level * 700,
              y: origin.y + row * 540,
              props,
            });
          }
        }
      },
      { history: "ignore" }
    );
  }

  private lineage(project: DbtProject) {
    const binding = project.binding!;
    const shapes = new Map(
      dbtShapes(this.editor)
        .filter((shape) => shape.props.bindingId === binding.id)
        .map((shape) => [shape.props.path, shape])
    );
    const desired = new Map<string, { from: DbtFileView; to: DbtFileView }>();
    for (const file of project.files) {
      const to = shapes.get(file.path);
      if (!to || to.type === "sql-text-area" || to.type === "dbt-macro") continue;
      for (const dependency of file.dependsOn) {
        const from = shapes.get(dependency);
        if (from && from.type !== "dbt-macro" && from.id !== to.id)
          desired.set(JSON.stringify([from.id, to.id]), { from, to });
      }
    }
    this.editor.run(
      () => {
        for (const shape of this.editor.getCurrentPageShapes()) {
          if (shape.type !== "arrow" || shape.meta.dbtBinding !== binding.id) continue;
          const key = String(shape.meta.dbtEdge);
          if (desired.has(key)) desired.delete(key);
          else this.editor.deleteShape(shape.id);
        }
        for (const [key, { from, to }] of desired) {
          const id = createShapeId();
          this.editor.createShape<TLArrowShape>({
            id,
            type: "arrow",
            x: from.x + from.props.w,
            y: from.y + from.props.h / 2,
            meta: { dbtBinding: binding.id, dbtEdge: key },
            props: {
              kind: "elbow",
              size: "s",
              color: "grey",
              start: { x: 0, y: 0 },
              end: { x: to.x - from.x - from.props.w, y: to.y - from.y },
              arrowheadEnd: "arrow",
            },
          });
          this.editor.createBindings<TLArrowBinding>([
            {
              type: "arrow",
              fromId: id,
              toId: from.id,
              props: { terminal: "start", normalizedAnchor: { x: 1, y: 0.5 }, isExact: false, isPrecise: true },
            },
            {
              type: "arrow",
              fromId: id,
              toId: to.id,
              props: { terminal: "end", normalizedAnchor: { x: 0, y: 0.5 }, isExact: false, isPrecise: true },
            },
          ]);
          this.editor.sendToBack([id]);
        }
      },
      { history: "ignore" }
    );
  }

  resolve(id: TLShapeId, choice: "disk" | "canvas") {
    return this.enqueue(async () => {
      if (!this.active()) throw new Error("Wait for the canvas to reconnect.");
      const issue = dbtState.get().issues[id];
      const shape = dbtFileView(this.editor.getShape(id));
      if (!shape || !issue?.disk) throw new Error("Refresh the project before resolving this file.");
      if (choice === "disk") {
        // Record the draft replacement so Undo can recover the canvas version.
        updateDbtFile(this.editor, shape, { text: issue.disk.text });
        this.update(dbtFileView(this.editor.getShape(id))!, {
          baseText: issue.disk.text,
          revision: issue.disk.revision,
          readOnly: issue.disk.readOnly,
        });
      } else {
        if (issue.disk.readOnly) throw new Error("This file is too large to write from the canvas.");
        await this.write(shape, issue.disk);
      }
      const issues = { ...dbtState.get().issues };
      delete issues[id];
      publish({ issues });
      this.failedWrites.delete(id);
    });
  }
}

export function DbtRuntime() {
  const editor = useEditor();
  useEffect(() => {
    const controller = new DbtController(editor);
    controllers.set(editor, controller);
    return () => {
      controller.stop();
      controllers.delete(editor);
    };
  }, [editor]);
  return null;
}
