import { PythonIcon } from "./PythonIcon";
import { useCallback, useEffect, useRef, useState } from "react";
import { BaseBoxShapeTool, HTMLContainer, Rectangle2d, ShapeUtil, T, createShapeId, createShapePropsMigrationSequence, resizeBox,
  type RecordProps, type TLResizeInfo, type TLShapeId } from "tldraw";
import { Play, Square, Table2, ChartNoAxesCombined, Package, X } from "lucide-react";
import { pythonLanguage } from "@codemirror/lang-python";
import { SQLTextAreaProps } from "../SQLTextArea/sql-text-area-props";
import { LazySQLEditor } from "../SQLTextArea/LazySQLEditor";
import type { EditorValidationIssue } from "../SQLTextArea/editor-validation";
import { useData } from "../client/useLocalServer";
import EditableText from "../util/EditableText";
import { getUniqueName } from "../util/getUniqueName";
import { connectShapes, disconnectShapes } from "../util/shapeConnections";
import { cancelComputeRun, ensureComputeTable, invalidatePythonResults, markDescendantsStale, runComputeGraph } from "./execution";
import { pythonRequest, pythonShapeReference, type PythonAnalysis, type PythonConfig, type PythonShape } from "./types";

const props: RecordProps<PythonShape> = { ...SQLTextAreaProps, output: T.string, errorLine: T.number.nullable() };
const buttonClass = "h-9 px-2 border-2 border-black rounded text-xs font-bold flex items-center justify-center gap-1 cursor-pointer bg-white hover:bg-green-100 disabled:opacity-50 disabled:cursor-default";

export class PythonShapeTool extends BaseBoxShapeTool {
  static override id = "python-text-area";
  static override initial = "idle";
  override shapeType = "python-text-area";
  override onPointerDown() {
    const { currentPagePoint } = this.editor.inputs;
    this.editor.createShape({ type: this.shapeType, x: currentPagePoint.x - 240, y: currentPagePoint.y - 160 });
    this.editor.setCurrentTool("select");
  }
}

export class PythonShapeUtil extends ShapeUtil<PythonShape> {
  static override type = "python-text-area" as const;
  static override props = props;
  static override migrations = createShapePropsMigrationSequence({ sequence: [] });
  override canResize() { return true; }
  override isAspectRatioLocked() { return false; }
  override canEdit() { return true; }
  getDefaultProps(): PythonShape["props"] {
    return { w: 500, h: 340, name: getUniqueName(this.editor, "python"),
      text: 'import pandas as pd\n\n# Reference another shape by its name.\nresult = pd.DataFrame({"x": [1, 2, 3], "y": [2, 4, 8]})',
      linkedTableId: null, error: null, isRunning: false, query: null, downstreamShapeIds: null, upstreamShapeIds: null,
      stale: false, isDirty: true, queryStartTime: null, showTable: true, runnerName: null, lastRunStats: null,
      outputSchema: null, columnStats: null, isManuallyResized: false, output: "", errorLine: null };
  }
  getGeometry(shape: PythonShape) { return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true }); }
  override onResize(shape: PythonShape, info: TLResizeInfo<PythonShape>) {
    return { ...resizeBox(shape, info), props: { ...resizeBox(shape, info).props, isManuallyResized: true } };
  }
  indicator(shape: PythonShape) { return <rect width={shape.props.w} height={shape.props.h} rx={12} />; }
  component(shape: PythonShape) { return <PythonShapeComponent shape={shape} util={this} />; }
}

function PythonShapeComponent({ shape, util }: { shape: PythonShape; util: PythonShapeUtil }) {
  const editor = util.editor;
  const api = useData();
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!shape.props.isRunning || !shape.props.queryStartTime) return;
    const tick = () => setElapsed((Date.now() - shape.props.queryStartTime!) / 1000);
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [shape.props.isRunning, shape.props.queryStartTime]);
  const [packagesOpen, setPackagesOpen] = useState(false);
  const [requirements, setRequirements] = useState("");
  const [packageError, setPackageError] = useState<string | null>(null);
  const [packageBusy, setPackageBusy] = useState(false);
  const [packageStatus, setPackageStatus] = useState("");
  const packageController = useRef<AbortController | null>(null);
  const analysisController = useRef<AbortController | null>(null);
  useEffect(() => () => { packageController.current?.abort(); analysisController.current?.abort(); }, []);
  const update = (values: Partial<PythonShape["props"]>) => editor.updateShape({ id: shape.id, type: shape.type, props: values });
  const run = () => { void runComputeGraph(editor, shape.id, api).catch(error => { if (error?.name !== "AbortError") update({ error: error instanceof Error ? error.message : String(error) }); }); };
  const onChange = (text: string) => {
    update({ text, isDirty: true, stale: true, errorLine: null });
    markDescendantsStale(editor, shape.id);
  };
  const validator = useCallback(async (code: string): Promise<EditorValidationIssue | null> => {
    let syntaxError: number | null = null;
    pythonLanguage.parser.parse(code).iterate({ enter(node) { if (node.type.isError && syntaxError === null) syntaxError = node.from; } });
    if (syntaxError !== null) return { message: "Invalid Python syntax", from: syntaxError, to: Math.min(code.length, syntaxError + 1) };
    const current = editor.getShape<PythonShape>(shape.id);
    if (current?.props.error && current.props.errorLine && current.props.text === code) return { message: current.props.error, line: current.props.errorLine };
    analysisController.current?.abort();
    const controller = new AbortController(); analysisController.current = controller;
    try {
      const names = editor.getCurrentPageShapes().flatMap(s => "name" in s.props ? [s.props.name] : []);
      const response = await pythonRequest<PythonAnalysis>("/analyze", { code, names, prepare: false }, controller.signal);
      return response.error ? { message: response.error, line: response.line, column: response.column } : null;
    } catch (error) {
      if (controller.signal.aborted) return null;
      return { message: error instanceof Error ? error.message : String(error) };
    }
  }, [editor, shape.id, shape.props.error, shape.props.errorLine]);
  const chain = (python: boolean) => {
    const id = createShapeId();
    editor.createShape({ id, type: python ? "python-text-area" : "sql-text-area", x: shape.x + shape.props.w + 60, y: shape.y,
      props: { text: python ? `result = ${pythonShapeReference(shape.props.name)}.copy()` : `SELECT * FROM "${shape.props.name.replaceAll('"', '""')}"` } });
    connectShapes(editor, shape.id, id); editor.select(id);
  };
  const chart = () => {
    const id = createShapeId();
    editor.createShape({ id, type: "chart-shape", x: shape.x, y: shape.y - 460, props: { sourceShapeId: shape.id, w: 600, h: 400 } });
    connectShapes(editor, shape.id, id);
  };
  const toggleTable = () => {
    if (shape.props.showTable) {
      if (shape.props.linkedTableId) {
        disconnectShapes(editor, shape.id, shape.props.linkedTableId as TLShapeId);
        editor.deleteShape(shape.props.linkedTableId as TLShapeId);
      }
      update({ showTable: false, linkedTableId: null });
    } else {
      update({ showTable: true });
      ensureComputeTable(editor, { ...shape, props: { ...shape.props, showTable: true } });
    }
  };
  const openPackages = async () => {
    setPackagesOpen(true); setPackageError(null);
    try {
      const response = await pythonRequest<{ config: PythonConfig; ready: boolean }>("", undefined, undefined, "GET");
      setRequirements(response.config.requirements.join("\n"));
      setPackageStatus(response.ready ? `Python ${response.config.version} · Ready` : "Environment will be prepared on Apply or Run");
    } catch (error) { setPackageError(String(error)); }
  };
  const applyPackages = async () => {
    const controller = new AbortController(); packageController.current = controller;
    setPackageBusy(true); setPackageError(null); setPackageStatus("Preparing Python and installing packages…");
    try {
      const response = await pythonRequest<{ config: PythonConfig }>("", { requirements: requirements.split("\n").map(s => s.trim()).filter(Boolean) }, controller.signal, "PUT");
      invalidatePythonResults(editor);
      setPackageStatus(`Python ${response.config.version} · Ready`);
      // Requirements are staged in the backend manifest and saved with the document.
      window.dispatchEvent(new Event("kavla:python-environment-changed"));
    } catch (error) { setPackageError(controller.signal.aborted ? "Package setup cancelled." : String(error)); }
    finally { setPackageBusy(false); packageController.current = null; }
  };
  return <HTMLContainer style={{ width: shape.props.w, height: shape.props.h, border: "4px solid #000", borderRadius: 12,
    background: "white", display: "flex", flexDirection: "column", pointerEvents: "all", overflow: "hidden" }}>
    <div style={{ background: "#dcfce7", borderBottom: "4px solid black", padding: "8px 12px", display: "flex", gap: 8, alignItems: "center" }}>
      <PythonIcon />
      <EditableText text={shape.props.name} editor={editor} shapeId={shape.id} onSave={name => { update({ name, isDirty: true }); markDescendantsStale(editor, shape.id); }} />
      <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 800 }}>PYTHON · CLI</span>
    </div>
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <div style={{ flex: 1, minWidth: 0 }}><LazySQLEditor shapeId={shape.id} text={shape.props.text} language="python" onChange={onChange} onRun={run} validator={validator} /></div>
      <div onPointerDown={e => e.stopPropagation()} style={{ padding: 8, background: "#f3f4f6", borderLeft: "4px solid black", display: "flex", flexDirection: "column", gap: 6, overflowY: "auto" }}>
        <button className={buttonClass} onClick={chart}><ChartNoAxesCombined size={14} />Chart</button>
        <button className={buttonClass} onClick={toggleTable}><Table2 size={14} />{shape.props.showTable ? "Hide table" : "Table"}</button>
        <button className={buttonClass} onClick={() => chain(false)}>SQL →</button>
        <button className={buttonClass} onClick={() => chain(true)}>Python →</button>
        <button className={buttonClass} onClick={() => void openPackages()}><Package size={14} />Packages</button>
        <button className={buttonClass} style={{ background: "#dcfce7", marginTop: "auto" }} onClick={shape.props.isRunning ? () => cancelComputeRun(editor, api) : run}>
          {shape.props.isRunning ? <Square size={14} /> : <Play size={14} />}{shape.props.isRunning ? "Stop" : "Run"}</button>
      </div>
    </div>
    <div onPointerDown={e => e.stopPropagation()} style={{ borderTop: "2px solid black", padding: "5px 10px", fontSize: 11, maxHeight: 140, overflow: "auto" }}>
      {shape.props.isRunning ? `Running… ${elapsed.toFixed(1)}s` : shape.props.lastRunStats ? `${shape.props.lastRunStats.rowCount.toLocaleString()} rows · ${shape.props.lastRunStats.executionTime} ms${shape.props.stale || shape.props.isDirty ? " · Stale" : ""}` : "Assign a DataFrame to result, then Run"}
      {shape.props.error && <pre style={{ color: "#b91c1c", whiteSpace: "pre-wrap", margin: "6px 0" }}>{shape.props.error}</pre>}
      {shape.props.output && <details><summary>Output</summary><pre style={{ whiteSpace: "pre-wrap" }}>{shape.props.output}</pre></details>}
    </div>
    {packagesOpen && <div onPointerDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()} style={{ position: "absolute", inset: 0, background: "white", borderRadius: 8, padding: 16, display: "flex", flexDirection: "column", gap: 10, zIndex: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 800 }}>Canvas Python packages<button title="Close packages" disabled={packageBusy} onClick={() => setPackagesOpen(false)}><X size={18} /></button></div>
      <div style={{ fontSize: 12 }}>One package per line, optionally with a version. pandas, NumPy and PyArrow are always included.</div>
      <textarea aria-label="Python package requirements" disabled={packageBusy} value={requirements} onChange={e => setRequirements(e.target.value)} style={{ flex: 1, minHeight: 40, resize: "none", border: "2px solid black", padding: 8, fontFamily: "monospace" }} />
      <div style={{ fontSize: 11 }}>{packageStatus}</div>
      {packageError && <div style={{ fontSize: 11, color: "#b91c1c", maxHeight: 70, overflow: "auto" }}>{packageError}</div>}
      <button className={buttonClass} onClick={packageBusy ? () => packageController.current?.abort() : () => void applyPackages()}>{packageBusy ? "Cancel setup" : "Apply"}</button>
    </div>}
  </HTMLContainer>;
}
