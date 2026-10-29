import { useEffect, useState } from "react";
import { useEditor, useValue } from "tldraw";
import { canvasSQLSignature, getCompiledDbtQuery } from "../Dbt/dbtCompilation";
import { hasDbtTemplate } from "../Dbt/dbtSQL";
import { compileCanvasSQL } from "./prepareCanvasSQL";
import { getOrderedDependenciesForSQL } from "./sqlDependencies";

// Compile templates for inspection only. The model source and its results stay untouched.
export function useSQLBizQuery(text: string) {
  const editor = useEditor();
  const query = useValue(
    "Biz compiled SQL",
    () => {
      const needsCompilation =
        hasDbtTemplate(text) ||
        getOrderedDependenciesForSQL(editor, text).orderedDependencies.some(
          (shape) => shape.type === "sql-text-area" && hasDbtTemplate(shape.props.text)
        );
      if (!needsCompilation) return { key: text, sql: text };
      return { key: JSON.stringify([text, canvasSQLSignature(editor)]), sql: getCompiledDbtQuery(editor, text) };
    },
    [editor, text]
  );
  const [failure, setFailure] = useState<{ key: string; error: string } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (query.sql !== undefined) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void compileCanvasSQL(editor, text, controller.signal).catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setFailure({ key: query.key, error: error instanceof Error ? error.message : String(error) });
        }
      });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [editor, text, query.key, query.sql, attempt]);

  return {
    sql: query.sql,
    error: query.sql === undefined && failure?.key === query.key ? failure.error : null,
    retry: () => {
      setFailure(null);
      setAttempt((value) => value + 1);
    },
  };
}
