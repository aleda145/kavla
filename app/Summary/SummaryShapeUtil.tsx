import { HTMLContainer, Rectangle2d, ShapeUtil, TLResizeInfo, TLShapeId, resizeBox } from "tldraw";
import { SummaryShapeMigrations } from "./summary-shape-migrations";
import { SummaryShapeProps } from "./summary-shape-props";
import type { SummaryArtifact, SummaryShape } from "./summary-shape-types";
import { SummaryBody } from "./SummaryBody";
import { SummaryHeader } from "./SummaryHeader";

export class SummaryShapeUtil extends ShapeUtil<SummaryShape> {
  static override type = "summary-shape" as const;
  static override props = SummaryShapeProps;
  static override migrations = SummaryShapeMigrations;

  override isAspectRatioLocked(_shape: SummaryShape) {
    return false;
  }

  override canResize(_shape: SummaryShape) {
    return true;
  }

  getDefaultProps(): SummaryShape["props"] {
    return {
      w: 560,
      h: 680,
      name: "Summary",
      question: "",
      answer: "",
      sections: [],
      artifacts: [],
      sourceJobId: null,
      agentShapeId: null,
    };
  }

  getGeometry(shape: SummaryShape) {
    return new Rectangle2d({
      width: shape.props.w,
      height: shape.props.h,
      isFilled: true,
    });
  }

  component(shape: SummaryShape) {
    const navigateToArtifact = (artifact: SummaryArtifact) => {
      const artifactId = artifact.shapeId as TLShapeId;
      const target = this.editor.getShape(artifactId);
      const bounds = target ? this.editor.getShapePageBounds(artifactId) : null;
      if (!target || !bounds) {
        return;
      }

      this.editor.select(artifactId);
      this.editor.zoomToBounds(bounds, {
        targetZoom: this.editor.getZoomLevel(),
        animation: { duration: 220 },
      });
    };

    return (
      <HTMLContainer
        id={shape.id}
        onWheel={(e) => e.stopPropagation()}
        onTouchMove={(e) => e.stopPropagation()}
        style={{
          display: "flex",
          flexDirection: "column",
          pointerEvents: "all",
          width: "100%",
          height: "100%",
          border: "4px solid #000",
          borderRadius: 12,
          overflow: "hidden",
          backgroundColor: "#fff",
          boxSizing: "border-box",
          fontFamily: "Inter, sans-serif",
        }}
      >
        <SummaryHeader name={shape.props.name} />
        <SummaryBody
          answer={shape.props.answer}
          artifacts={shape.props.artifacts}
          question={shape.props.question}
          sections={shape.props.sections}
          onNavigateToArtifact={navigateToArtifact}
        />
      </HTMLContainer>
    );
  }

  indicator(shape: SummaryShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={12} ry={12} />;
  }

  override onResize(shape: SummaryShape, info: TLResizeInfo<SummaryShape>) {
    return resizeBox(shape, info);
  }
}
