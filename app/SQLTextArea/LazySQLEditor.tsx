import { useEditor, useValue, TLShapeId } from "tldraw";
import { StaticSQLHighlighter } from "./StaticSQLHighlighter";
import { StaticCodeHighlighter } from "../util/StaticCodeHighlighter";
import { LiveCodeMirror } from "./LiveCodeMirror";
import type { LiveCodeMirrorLanguage } from "./LiveCodeMirror";
import type { EditorView } from "@codemirror/view";
import { buildSqlSchemaIndex } from "./schema-index";

interface LazySQLEditorProps {
  shapeId: TLShapeId;
  text: string;
  onChange: (val: string) => void;
  language?: LiveCodeMirrorLanguage;
  activateOnSelection?: boolean;
  onRun?: () => void;
  onFormat?: (val?: string) => void;
  validator?: (sql: string) => Promise<import("./editor-validation").EditorValidationIssue | null>;
  onCreateEditor?: (view: EditorView) => void;
  forceLive?: boolean;
}

import { useSchemaRegistry } from "../hooks/useSchemaRegistry";
import { useMemo, useEffect, useState, useCallback } from "react";

let globalStylesMounted = false;

export const LazySQLEditor = ({
  shapeId,
  text,
  onChange,
  language = "sql",
  activateOnSelection = true,
  onRun,
  onFormat,
  validator,
  onCreateEditor,
  forceLive = false,
}: LazySQLEditorProps) => {
  const editor = useEditor();
  const registry = useSchemaRegistry();
  const isSqlMode = language === "sql";

  // CodeMirror injects its styles only after mounting, so mount one hidden
  // instance before the first static SQL view is displayed.
  const [mountHack, setMountHack] = useState(isSqlMode && !globalStylesMounted);

  useEffect(() => {
    if (mountHack) {
      globalStylesMounted = true;
      const t = setTimeout(() => setMountHack(false), 50);
      return () => clearTimeout(t);
    }
  }, [mountHack]);

  const { tableNames, sources, queries, columnMapping } = useMemo(() => buildSqlSchemaIndex(registry), [registry]);

  const isSelected = useValue(
    "isSelected",
    () => {
      return editor.getSelectedShapeIds().includes(shapeId);
    },
    [editor, shapeId]
  );

  const [isHovered, setIsHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [activeTooltipCount, setActiveTooltipCount] = useState(0);

  const isActive = forceLive || (activateOnSelection && isSelected) || isHovered || isFocused || activeTooltipCount > 0;
  const shouldRenderLive = isActive || mountHack;
  const shouldShowLive = isActive;

  const handleTooltipChange = useCallback((isOpen: boolean) => {
    setActiveTooltipCount((prev) => Math.max(0, prev + (isOpen ? 1 : -1)));
  }, []);

  // Connected sources rank first in autocomplete.
  const upstreamTableNames = useMemo(() => {
    const shape = editor.getShape(shapeId);
    if (!shape || "upstreamShapeIds" in shape.props === false) return [];

    const upstreamIds = (shape.props as any).upstreamShapeIds || [];
    const names: string[] = [];

    upstreamIds.forEach((id: string) => {
      const s = editor.getShape(id as TLShapeId);
      if (s && "name" in s.props) {
        names.push(s.props.name);
      }
    });
    return names;
  }, [editor, shapeId]);

  return (
    <div
      style={{ width: "100%", height: "100%", borderBottomLeftRadius: "inherit" }}
      onPointerEnter={() => setIsHovered(true)}
      onPointerLeave={() => setIsHovered(false)}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onFocus={() => {
        setIsFocused(true);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setIsFocused(false);
          if (onFormat) onFormat();
        }
      }}
    >
      {shouldRenderLive ? (
        <div
          style={
            shouldShowLive ? { width: "100%", height: "100%", borderBottomLeftRadius: "inherit" } : { display: "none" }
          }
        >
          <LiveCodeMirror
            shapeId={shapeId}
            value={text}
            onChange={onChange}
            language={language}
            onRun={onRun}
            onFormat={onFormat}
            onTooltipActive={handleTooltipChange}
            upstreamTableNames={upstreamTableNames}
            validator={validator}
            onCreateEditor={onCreateEditor}
          />
        </div>
      ) : !isSqlMode ? (
        <StaticCodeHighlighter code={text} />
      ) : (
        <StaticSQLHighlighter
          sql={text}
          validTableNames={tableNames}
          sources={sources}
          queries={queries}
          columnMapping={columnMapping}
          upstreamTableNames={upstreamTableNames}
        />
      )}
    </div>
  );
};
