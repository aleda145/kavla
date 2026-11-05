import { useEffect, useRef, useState } from "react";
import { ArrowDownUp, ArrowLeft, Play, Plus, X } from "lucide-react";
import { TldrawUiButton } from "tldraw";
import type { SQLDependencyShape } from "../../SQLTextArea/sqlDependencies";
import { buildSelectionQuery, getSelectionSchema, type KeyMapping } from "../../SQLTextArea/selectionOperations";
import { getSelectionOperationDefaults, suggestSelectionKey } from "../../SQLTextArea/selectionOperationDefaults";

export function SelectionOperationPanel({
  operation,
  inputs: selectedInputs,
  height,
  onRun,
  onBack,
}: {
  operation: "JOIN" | "EXCEPT" | "DIFF";
  inputs: SQLDependencyShape[];
  height: number;
  onRun: (inputIds: SQLDependencyShape["id"][], keys: KeyMapping[]) => void;
  onBack: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const [defaults] = useState(() => getSelectionOperationDefaults(operation, selectedInputs));
  const [inputIds, setInputIds] = useState(defaults.inputIds);
  const inputs = inputIds.map((id) => selectedInputs.find((input) => input.id === id)!);
  const [useKeys, setUseKeys] = useState(defaults.useKeys);
  const [keys, setKeys] = useState<KeyMapping[]>(defaults.keys);
  const needsKeys = operation === "JOIN" || (operation === "DIFF" && useKeys);
  const incompleteKeys = needsKeys && keys.some((mapping) => mapping.some((column) => !column));
  let error: string | null = null;
  try {
    buildSelectionQuery(operation, inputs, needsKeys ? keys : []);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const title = operation === "JOIN" ? "Join" : operation === "DIFF" ? "Diff" : "Except";

  useEffect(() => {
    back.current?.focus();
    // Stop native wheel events before the style panel forwards them to the canvas.
    const element = root.current;
    const onWheel = (event: WheelEvent) => event.stopPropagation();
    element?.addEventListener("wheel", onWheel, { passive: true });
    return () => element?.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const panel = root.current?.closest(".tlui-style-panel");
    if (!panel) return;
    // Listen on the panel itself: tldraw handles Escape there during capture.
    const onKeyDown = (event: Event) => {
      if ((event as KeyboardEvent).key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onBack();
      }
    };
    panel.addEventListener("keydown", onKeyDown, { capture: true });
    return () => panel.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [onBack]);

  return (
    <div
      ref={root}
      className="kavla-selection-setup"
      style={{ height }}
      role="group"
      aria-label={`${title} selected datasets`}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="kavla-selection-setup-header">
        <TldrawUiButton
          ref={back}
          type="icon"
          title="Back to selection (Esc)"
          aria-label="Back to selection"
          onClick={onBack}
        >
          <ArrowLeft size={16} aria-hidden />
        </TldrawUiButton>
        <strong>{title}</strong>
      </div>
      <div className="kavla-selection-setup-body">
        <p
          className="kavla-selection-setup-hint"
          title="Defaults are suggested from column and dataset names. Check them before running."
        >
          Review, then run.
        </p>
        {operation === "EXCEPT" ? (
          <>
            <label>
              <span>Keep rows from</span>
              <select
                value={inputIds[0]}
                title={inputs[0].props.name}
                onChange={(event) => {
                  const first = event.currentTarget.value as SQLDependencyShape["id"];
                  setInputIds([first, ...inputIds.filter((id) => id !== first)]);
                }}
              >
                {selectedInputs.map((input) => (
                  <option key={input.id} value={input.id}>
                    {input.props.name}
                  </option>
                ))}
              </select>
            </label>
            <p>Remove rows in:</p>
            {inputs.slice(1).map((input) => (
              <span className="kavla-selection-setup-name" key={input.id} title={input.props.name}>
                {input.props.name}
              </span>
            ))}
            <p className="kavla-selection-setup-hint">Distinct rows. Columns match by position.</p>
          </>
        ) : (
          <>
            {operation === "DIFF" && (
              <>
                <div className="kavla-selection-setup-inputs">
                  {inputs.map((input, index) => (
                    <div key={input.id}>
                      <span>{index === 0 ? "Before" : "After"}</span>
                      <strong className="kavla-selection-setup-name" title={input.props.name}>
                        {input.props.name}
                      </strong>
                    </div>
                  ))}
                  <TldrawUiButton
                    type="icon"
                    title="Swap before and after"
                    aria-label="Swap before and after"
                    onClick={() => {
                      setInputIds([...inputIds].reverse());
                      setKeys(keys.map((mapping) => [...mapping].reverse()));
                    }}
                  >
                    <ArrowDownUp size={14} aria-hidden />
                  </TldrawUiButton>
                </div>
                <label>
                  <span>Compare by</span>
                  <select
                    value={useKeys ? "keys" : "rows"}
                    onChange={(event) => setUseKeys(event.currentTarget.value === "keys")}
                  >
                    <option value="rows">Whole rows</option>
                    <option value="keys">Matching keys</option>
                  </select>
                </label>
              </>
            )}
            {needsKeys && (
              <>
                {operation === "JOIN" && <p>Keep matching rows.</p>}
                {keys.map((mapping, keyIndex) => (
                  <fieldset key={keyIndex}>
                    <legend>Key {keyIndex + 1}</legend>
                    {inputs.map((input, inputIndex) => (
                      <label key={input.id}>
                        <span className="kavla-selection-setup-name" title={input.props.name}>
                          {input.props.name}
                        </span>
                        <select
                          aria-label={`Key ${keyIndex + 1} for ${input.props.name}`}
                          title={mapping[inputIndex] || "Choose a column"}
                          value={mapping[inputIndex]}
                          onChange={(event) => {
                            const value = event.currentTarget.value;
                            setKeys(
                              keys.map((key, index) =>
                                index === keyIndex
                                  ? key.map((column, columnIndex) => (columnIndex === inputIndex ? value : column))
                                  : key
                              )
                            );
                          }}
                        >
                          <option value="">Choose column</option>
                          {getSelectionSchema(input)?.map((column) => (
                            <option key={column.name} value={column.name}>
                              {column.name} ({column.type})
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                    {keys.length > 1 && (
                      <TldrawUiButton
                        type="icon"
                        title={`Remove key ${keyIndex + 1}`}
                        aria-label={`Remove key ${keyIndex + 1}`}
                        onClick={() => setKeys(keys.filter((_, index) => index !== keyIndex))}
                      >
                        <X size={14} aria-hidden />
                        <span className="kavla-control-label">Remove key</span>
                      </TldrawUiButton>
                    )}
                  </fieldset>
                ))}
                <TldrawUiButton
                  type="icon"
                  title="Add matching key"
                  aria-label="Add matching key"
                  onClick={() =>
                    setKeys([...keys, suggestSelectionKey(inputs, operation, keys) ?? inputs.map(() => "")])
                  }
                >
                  <Plus size={14} aria-hidden />
                  <span className="kavla-control-label">Add key</span>
                </TldrawUiButton>
              </>
            )}
            {operation === "DIFF" && (
              <p className="kavla-selection-setup-hint">
                {useKeys
                  ? "Keys must be unique. Finds added, removed and changed rows."
                  : "Distinct rows. Finds added and removed rows."}
              </p>
            )}
          </>
        )}
        {error && !(incompleteKeys && error === "Choose a matching column for every input and key.") && (
          <p role="status" className="kavla-selection-setup-error">
            {error}
          </p>
        )}
      </div>
      <div className="kavla-selection-setup-footer">
        <TldrawUiButton
          type="icon"
          title={incompleteKeys ? "Choose a column for each input" : error || `Create and run ${title} query`}
          aria-label={`Create and run ${title} query`}
          disabled={Boolean(error)}
          onClick={() => onRun(inputIds, needsKeys ? keys : [])}
        >
          <Play size={14} aria-hidden />
          <span className="kavla-control-label">Run {title.toLowerCase()}</span>
        </TldrawUiButton>
      </div>
    </div>
  );
}
