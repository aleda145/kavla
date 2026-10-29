import { dbtColors } from "./dbtColors";
import { BriefcaseBusiness, Code2, SquareFunction } from "lucide-react";
import { useMemo } from "react";
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
import { setQueryBizMode, useBizMode } from "../client/canvas/bizMode";
import { SQLBizPipeline } from "../SQLTextArea/SQLBizBody";
import { getDbtMacroBizSummary } from "./dbtBizSummary";

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
    const bizMode = useBizMode(this.editor, shape.id);
    const summary = useMemo(
      () => (bizMode ? getDbtMacroBizSummary(shape.props.text) : null),
      [bizMode, shape.props.text]
    );
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
              details: [`Functions: ${names.join(", ") || "No macro declaration yet"}`],
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
              background: dbtColors.surface,
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
            <span
              style={{
                marginLeft: "auto",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                flexShrink: 0,
                fontSize: 10,
                lineHeight: "14px",
                fontWeight: 800,
                padding: "3px 6px",
                border: "1px solid #000",
                borderRadius: 999,
                background: dbtColors.surface,
                color: "#000",
                whiteSpace: "nowrap",
              }}
            >
              <SquareFunction size={13} strokeWidth={2} aria-hidden style={{ flexShrink: 0 }} />
              Macro
            </span>
            <button
              type="button"
              aria-label="Biz mode for this macro"
              aria-pressed={bizMode}
              title={bizMode ? "Biz mode · click to show SQL" : "SQL mode · click to show Biz flow"}
              onClick={() => setQueryBizMode(this.editor, shape.id, !bizMode)}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              className="flex h-6 w-7 shrink-0 items-center justify-center rounded border-2 border-black bg-white p-0 text-black shadow-none cursor-pointer aria-pressed:translate-x-px aria-pressed:translate-y-px active:translate-x-px active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
            >
              {bizMode ? <BriefcaseBusiness size={14} aria-hidden /> : <Code2 size={14} aria-hidden />}
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {bizMode && summary ? (
              <SQLBizPipeline text={p.text} shape={shape} summary={summary} />
            ) : (
              <LazySQLEditor
                shapeId={shape.id}
                text={p.text}
                readOnly={readOnly || p.readOnly}
                onChange={(text) =>
                  this.editor.updateShape<DbtMacroShape>({ id: shape.id, type: shape.type, props: { text } })
                }
              />
            )}
          </div>
          <button
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={openSettings}
            style={{
              border: 0,
              borderTop: "2px solid #000",
              background: issue ? "#fee2e2" : dbtColors.subtle,
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
