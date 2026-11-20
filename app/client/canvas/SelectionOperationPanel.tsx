import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDownUp, ArrowLeft, Plus, X } from "lucide-react";
import { TldrawUiButton } from "tldraw";
import type { SQLDependencyShape } from "../../SQLTextArea/sqlDependencies";
import { buildSelectionQuery, getSelectionSchema, type KeyMapping } from "../../SQLTextArea/selectionOperations";
import { getSelectionOperationDefaults, suggestSelectionKey } from "../../SQLTextArea/selectionOperationDefaults";
import { SelectionOperationSelect } from "./SelectionOperationSelect";

export function SelectionOperationPanel({
  operation,
  inputs: selectedInputs,
  height,
  onCreate,
  onBack,
}: {
  operation: "JOIN" | "EXCEPT" | "DIFF";
  inputs: SQLDependencyShape[];
  height: number;
  onCreate: (inputIds: SQLDependencyShape["id"][], keys: KeyMapping[]) => void;
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

  useLayoutEffect(() => {
    const element = root.current;
    const panel = element?.closest<HTMLElement>(".tlui-style-panel");
    const body = element?.querySelector<HTMLElement>(".kavla-selection-setup-body");
    const options = element?.querySelectorAll<HTMLElement>("[data-selection-option-measure]");
    if (!element || !panel || !body || !options?.length) return;

    // Measure the actual picker typography, padding, border and chevron.
    const optionWidth = Math.max(...Array.from(options, (option) => option.offsetWidth));
    const bodyStyle = getComputedStyle(body);
    const panelStyle = getComputedStyle(panel);
    const width =
      optionWidth +
      parseFloat(bodyStyle.paddingLeft) +
      parseFloat(bodyStyle.paddingRight) +
      (body.offsetWidth - body.clientWidth) +
      parseFloat(panelStyle.borderLeftWidth) +
      parseFloat(panelStyle.borderRightWidth);
    panel.style.setProperty("--kavla-selection-setup-width", `${Math.max(150, Math.ceil(width))}px`);
    return () => {
      panel.style.removeProperty("--kavla-selection-setup-width");
    };
  });

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
        {operation === "EXCEPT" ? (
          <>
            <div className="kavla-selection-setup-field">
              <span>Keep rows from</span>
              <SelectionOperationSelect
                label="Keep rows from"
                value={inputIds[0]}
                options={selectedInputs.map((input) => ({ value: input.id, label: input.props.name }))}
                onSelect={(value) => {
                  const first = value as SQLDependencyShape["id"];
                  setInputIds([first, ...inputIds.filter((id) => id !== first)]);
                }}
              />
            </div>
            <p>Remove rows in:</p>
            {inputs.slice(1).map((input) => (
              <span className="kavla-selection-setup-name" key={input.id} title={input.props.name}>
                {input.props.name}
              </span>
            ))}
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
                <div className="kavla-selection-setup-field">
                  <span>Compare by</span>
                  <SelectionOperationSelect
                    label="Compare by"
                    value={useKeys ? "keys" : "rows"}
                    options={[
                      { value: "rows", label: "Whole rows" },
                      { value: "keys", label: "Matching keys" },
                    ]}
                    onSelect={(value) => setUseKeys(value === "keys")}
                  />
                </div>
              </>
            )}
            {needsKeys && (
              <>
                {keys.map((mapping, keyIndex) => (
                  <fieldset key={keyIndex}>
                    <legend>Key {keyIndex + 1}</legend>
                    {inputs.map((input, inputIndex) => (
                      <div key={input.id} className="kavla-selection-setup-field">
                        <span className="kavla-selection-setup-name" title={input.props.name}>
                          {input.props.name}
                        </span>
                        <SelectionOperationSelect
                          label={`Key ${keyIndex + 1} for ${input.props.name}`}
                          value={mapping[inputIndex]}
                          options={(getSelectionSchema(input) ?? []).map((column) => ({
                            value: column.name,
                            label: column.name,
                            type: column.type,
                          }))}
                          onSelect={(value) => {
                            setKeys(
                              keys.map((key, index) =>
                                index === keyIndex
                                  ? key.map((column, columnIndex) => (columnIndex === inputIndex ? value : column))
                                  : key
                              )
                            );
                          }}
                        />
                      </div>
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
          title={incompleteKeys ? "Choose a column for each input" : error || `Create ${title} query`}
          aria-label={`Create ${title} query`}
          disabled={Boolean(error)}
          onClick={() => onCreate(inputIds, needsKeys ? keys : [])}
        >
          <Plus size={14} aria-hidden />
          <span className="kavla-control-label">Create {title.toLowerCase()}</span>
        </TldrawUiButton>
      </div>
    </div>
  );
}
