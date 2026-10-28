import { dbtColors } from "./dbtColors";
import { lazy, Suspense } from "react";
import {
  HTMLContainer,
  Rectangle2d,
  ShapeUtil,
  T,
  resizeBox,
  useValue,
  type RecordProps,
  type TLResizeInfo,
} from "tldraw";
import { dbtState } from "./dbtRuntime";
import type { DbtFileShape } from "./dbtTypes";
import logo from "./dbt-logo.svg";

const DbtCodeEditor = lazy(() => import("./DbtCodeEditor"));
export function DbtLogo({ size = 16 }: { size?: number }) {
  return <img src={logo} alt="" aria-hidden="true" width={size} height={size} style={{ flexShrink: 0 }} />;
}

export class DbtFileUtil extends ShapeUtil<DbtFileShape> {
  static override type = "dbt-file" as const;
  static override props: RecordProps<DbtFileShape> = {
    w: T.number,
    h: T.number,
    bindingId: T.string,
    projectRoot: T.string,
    path: T.string,
    kind: T.string,
    text: T.string,
    baseText: T.string,
    revision: T.string,
    readOnly: T.boolean,
  };
  getDefaultProps(): DbtFileShape["props"] {
    return {
      w: 560,
      h: 340,
      bindingId: "",
      projectRoot: "",
      path: "",
      kind: "model",
      text: "",
      baseText: "",
      revision: "",
      readOnly: false,
    };
  }
  override canEdit() {
    return false;
  }
  override canResize() {
    return true;
  }
  getGeometry(shape: DbtFileShape) {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true });
  }
  override onResize(shape: DbtFileShape, info: TLResizeInfo<DbtFileShape>) {
    return resizeBox(shape, info);
  }
  indicator(shape: DbtFileShape) {
    return <rect width={shape.props.w} height={shape.props.h} />;
  }
  component(shape: DbtFileShape) {
    const editor = this.editor;
    const { props: p } = shape;
    const selected = useValue("dbt selected", () => editor.getOnlySelectedShapeId() === shape.id, [editor, shape.id]);
    const readOnly = useValue("dbt readonly", () => editor.getInstanceState().isReadonly, [editor]);
    const status = useValue(
      "dbt file status",
      () => {
        const state = dbtState.get();
        const issue = state.issues[shape.id];
        const linked = state.project?.binding?.id === p.bindingId && state.project?.binding?.root === p.projectRoot;
        if (issue)
          return { text: issue.kind === "conflict" ? "Conflict · review both versions" : issue.message, problem: true };
        if (!linked) return { text: "Detached · changes stay on this canvas", problem: false };
        if (state.error) return { text: "Sync unavailable · open dbt settings", problem: true };
        if (state.paused) return { text: "Sync paused", problem: false };
        if (p.readOnly) return { text: "Read-only preview · file exceeds 256 KiB", problem: false };
        if (p.text !== p.baseText) return { text: "Changes waiting to save to disk…", problem: false };
        return { text: "Synced with disk", problem: false };
      },
      [shape.id, p.bindingId, p.projectRoot, p.text, p.baseText, p.readOnly]
    );
    const openSettings = () => window.dispatchEvent(new CustomEvent("kavla:open-dbt", { detail: shape.id }));
    const preview = (
      <pre
        style={{
          margin: 0,
          padding: 12,
          fontSize: 12,
          lineHeight: 1.6,
          fontFamily: "monospace",
          whiteSpace: "pre",
          overflow: "auto",
          height: "100%",
        }}
      >
        {p.text || "Empty file"}
      </pre>
    );
    return (
      <HTMLContainer
        id={shape.id}
        style={{
          width: p.w,
          height: p.h,
          border: "4px solid #000",
          borderRadius: 12,
          background: "white",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          pointerEvents: "all",
        }}
      >
        <div
          style={{
            padding: "8px 12px",
            borderBottom: "4px solid #000",
            background: p.kind === "model" ? "#fef08a" : p.kind === "properties" ? "#dbeafe" : dbtColors.surface,
            display: "flex",
            alignItems: "center",
            gap: 8,
            cursor: "grab",
            flexShrink: 0,
          }}
        >
          <DbtLogo />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase" }}>dbt · {p.kind}</div>
            <div
              title={`${p.projectRoot}/${p.path}`}
              style={{
                fontSize: 12,
                fontWeight: 700,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {p.path}
            </div>
          </div>
        </div>
        <div
          style={{ flex: 1, minHeight: 0, overflow: "hidden" }}
          onWheel={(event) => {
            if (selected) event.stopPropagation();
          }}
          onPointerDown={(event) => {
            if (selected) event.stopPropagation();
          }}
          onKeyDown={(event) => {
            if (!(event.key.toLowerCase() === "s" && (event.ctrlKey || event.metaKey))) event.stopPropagation();
          }}
        >
          {selected && !p.readOnly && !readOnly ? (
            <Suspense fallback={preview}>
              <DbtCodeEditor
                text={p.text}
                path={p.path}
                onChange={(text) =>
                  editor.updateShape<DbtFileShape>({ id: shape.id, type: shape.type, props: { text } })
                }
              />
            </Suspense>
          ) : (
            preview
          )}
        </div>
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={openSettings}
          style={{
            background: status.problem ? "#fee2e2" : "#f8fafc",
            color: status.problem ? "#991b1b" : "#475569",
            border: 0,
            borderTop: "2px solid #000",
            padding: "6px 10px",
            fontSize: 11,
            fontWeight: 700,
            textAlign: "left",
            cursor: "pointer",
            flexShrink: 0,
          }}
          title={status.text}
        >
          {status.text}
        </button>
      </HTMLContainer>
    );
  }
}
