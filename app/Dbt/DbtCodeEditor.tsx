import CodeMirror from "@uiw/react-codemirror";
import { sql } from "@codemirror/lang-sql";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useMemo } from "react";

export default function DbtCodeEditor({
  text,
  path,
  onChange,
}: {
  text: string;
  path: string;
  onChange: (text: string) => void;
}) {
  const crlf = text.includes("\r\n");
  const extensions = useMemo(
    () => [
      ...(path.endsWith(".sql") ? [sql()] : []),
      EditorState.lineSeparator.of(crlf ? "\r\n" : "\n"),
      EditorView.theme({
        "&": { height: "100%", fontSize: "12px" },
        ".cm-scroller": { overflow: "auto", fontFamily: "monospace" },
      }),
    ],
    [path, crlf]
  );
  return (
    <CodeMirror
      value={text}
      onChange={onChange}
      extensions={extensions}
      height="100%"
      style={{ height: "100%" }}
      basicSetup={{ autocompletion: false }}
    />
  );
}
