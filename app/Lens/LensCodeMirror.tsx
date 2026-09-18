import { useEffect } from "react";
import type { TLShapeId } from "tldraw";
import { TldrawScrollAreaIndicator } from "../DataSource/TldrawScrollAreaIndicator";
import { useTldrawScrollArea } from "../DataSource/useTldrawScrollArea";
import { LazySQLEditor } from "../SQLTextArea/LazySQLEditor";
import type { EditorValidationIssue } from "../SQLTextArea/editor-validation";
import type { LiveCodeMirrorLanguage } from "../SQLTextArea/LiveCodeMirror";
import { stopLensWidgetEventPropagation } from "./lens-events";

interface LensCodeMirrorProps {
  shapeId: TLShapeId;
  value: string;
  onChange: (value: string) => void;
  language: LiveCodeMirrorLanguage;
  onFormat?: (value?: string) => void;
  validator?: (sql: string) => Promise<EditorValidationIssue | null>;
}

export function LensCodeMirror({ shapeId, value, onChange, language, onFormat, validator }: LensCodeMirrorProps) {
  const { ref: setScrollAreaRef, indicator } = useTldrawScrollArea();

  useEffect(() => {
    return () => setScrollAreaRef(null);
  }, [setScrollAreaRef]);

  return (
    <div
      style={{ width: "100%", height: "100%" }}
      onPointerDown={stopLensWidgetEventPropagation}
      onPointerMove={stopLensWidgetEventPropagation}
      onPointerUp={stopLensWidgetEventPropagation}
      onPointerCancel={stopLensWidgetEventPropagation}
    >
      <LazySQLEditor
        shapeId={shapeId}
        text={value}
        onChange={onChange}
        language={language}
        activateOnSelection={false}
        forceLive
        onFormat={onFormat}
        validator={validator}
        onCreateEditor={(view) => setScrollAreaRef(view.scrollDOM)}
      />
      <TldrawScrollAreaIndicator indicator={indicator} />
    </div>
  );
}
