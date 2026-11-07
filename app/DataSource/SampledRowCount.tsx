import { useEffect } from "react";
import { type Editor, useValue } from "tldraw";
import type { LocalServerContextType } from "../client/localServer/types";
import type { DataSourceShape } from "./data-source-types";
import { getSampleRowCount, loadSampleRowCount, sampleRowCountKey } from "./sample-row-count";

export function SampledRowCount({
  editor,
  shape,
  runRemoteQuery,
}: {
  editor: Editor;
  shape: DataSourceShape;
  runRemoteQuery: LocalServerContextType["runRemoteQuery"];
}) {
  const key = useValue("Sample row count inputs", () => sampleRowCountKey(shape), [shape]);
  const current = useValue("Sample row count", () => getSampleRowCount(editor, shape), [editor, shape]);
  const percent = shape.props.samplePercent ?? 100;

  useEffect(() => {
    if (percent >= 100) return;
    // The shared request reports errors and retains its result for the control.
    // Let it finish on unmount; aborting discards the compute worker.
    void loadSampleRowCount(editor, shape, runRemoteQuery).catch(() => undefined);
  }, [key, editor, runRemoteQuery]);

  if (percent >= 100) return null;
  return (
    <div aria-live="polite" title={current?.error || "Count from the latest sample check"}>
      <strong>Sampled row count:</strong>{" "}
      {current?.count !== undefined ? `${current.count.toLocaleString()}~` : current?.error ? "—" : "…"}
    </div>
  );
}
