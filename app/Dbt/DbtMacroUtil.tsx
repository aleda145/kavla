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
import { LazySQLEditor } from "../SQLTextArea/LazySQLEditor";
import { ShapeEngineTabs } from "../util/ShapeEngineTabs";
import { DbtFileUtil, DbtLogo } from "./DbtFileUtil";
import { dbtState } from "./dbtState";
import { getDbtMacroNames } from "./dbtMacros";
import type { DbtMacroShape } from "./dbtTypes";

export class DbtMacroUtil extends ShapeUtil<DbtMacroShape> {
  static override type = "dbt-macro" as const;
  static override props: RecordProps<DbtMacroShape> = {
    ...DbtFileUtil.props,
    name: T.string,
    upstreamShapeIds: T.arrayOf(T.string).nullable(),
    downstreamShapeIds: T.arrayOf(T.string).nullable(),
  };
  getDefaultProps(): DbtMacroShape["props"] {
    return {
      w: 560,
      h: 340,
      name: "macro",
      kind: "macro",
      bindingId: "",
      projectRoot: "",
      path: "",
      text: "{% macro example(column_name) %}\n  {{ column_name }}\n{% endmacro %}",
      baseText: "",
      revision: "",
      readOnly: false,
      upstreamShapeIds: [],
      downstreamShapeIds: [],
    };
  }
  override canEdit() {
    return false;
  }
  override canResize() {
    return true;
  }
  getGeometry(shape: DbtMacroShape) {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true });
  }
  override onResize(shape: DbtMacroShape, info: TLResizeInfo<DbtMacroShape>) {
    return resizeBox(shape, info);
  }
  indicator(shape: DbtMacroShape) {
    return <rect width={shape.props.w} height={shape.props.h} />;
  }
  component(shape: DbtMacroShape) {
    const state = useValue("dbt macro sync", () => dbtState.get(), []);
    const readOnly = useValue("dbt macro readonly", () => this.editor.getInstanceState().isReadonly, [this.editor]);
    const p = shape.props;
    const issue = state.issues[shape.id];
    const status =
      issue?.message ??
      (state.project?.binding?.id !== p.bindingId
        ? "Detached"
        : state.error
          ? "Sync unavailable"
          : state.paused
            ? "Sync paused"
            : p.readOnly
              ? "Read-only file preview"
              : p.text !== p.baseText
                ? "Saving to disk…"
                : "Synced with disk");
    const names = getDbtMacroNames(p.text);
    const openSettings = () => window.dispatchEvent(new CustomEvent("kavla:open-dbt", { detail: shape.id }));
    return (
      <HTMLContainer
        id={shape.id}
        style={{ width: p.w, height: p.h, overflow: "visible", pointerEvents: "all", fontFamily: "Inter, sans-serif" }}
      >
        <ShapeEngineTabs
          tabs={[
            {
              key: "dbt-macro",
              type: "dbt",
              active: false,
              topOffset: 0,
              title: "dbt macro",
              onClick: openSettings,
              details: [
                `File: ${p.path}`,
                `Folder: ${p.projectRoot}`,
                `Functions: ${names.join(", ") || "No macro declaration yet"}`,
                `Used by ${(p.downstreamShapeIds ?? []).length} queries`,
                status,
                "Edit the template here; run SQL nodes that use it.",
              ],
            },
          ]}
          style={{ position: "absolute", top: -46, left: 0 }}
        />
        <div
          style={{
            height: "100%",
            boxSizing: "border-box",
            display: "flex",
            flexDirection: "column",
            border: "4px solid #000",
            borderRadius: 12,
            background: "white",
            overflow: "hidden",
            position: "relative",
            zIndex: 1,
          }}
        >
          <div
            style={{
              padding: "8px 12px",
              borderBottom: "4px solid #000",
              background: "#ffedd5",
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexShrink: 0,
            }}
          >
            <DbtLogo />
            <strong
              style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              title={p.path}
            >
              {p.path.split("/").pop() || p.name}
            </strong>
            <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 800 }}>MACRO</span>
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            <LazySQLEditor
              shapeId={shape.id}
              text={p.text}
              readOnly={readOnly || p.readOnly}
              onChange={(text) =>
                this.editor.updateShape<DbtMacroShape>({ id: shape.id, type: shape.type, props: { text } })
              }
            />
          </div>
          <button
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={openSettings}
            style={{
              border: 0,
              borderTop: "2px solid #000",
              background: issue ? "#fee2e2" : "#fff7ed",
              padding: "6px 10px",
              fontSize: 11,
              textAlign: "left",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            {status}
          </button>
        </div>
      </HTMLContainer>
    );
  }
}
