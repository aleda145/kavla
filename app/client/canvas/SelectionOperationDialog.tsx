import { useState } from "react";
import { ArrowDownUp, Plus, X } from "lucide-react";
import {
  TldrawUiDialogBody,
  TldrawUiDialogCloseButton,
  TldrawUiDialogFooter,
  TldrawUiDialogHeader,
  TldrawUiDialogTitle,
  type TLUiDialogProps,
} from "tldraw";
import type { SQLDependencyShape } from "../../SQLTextArea/sqlDependencies";
import {
  buildSelectionQuery,
  getSelectionSchema,
  type KeyMapping,
  type SelectionOperation,
} from "../../SQLTextArea/selectionOperations";

const buttonClass =
  "h-9 px-3 border-2 border-black text-black font-bold text-xs flex items-center justify-center gap-2 rounded cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed";
const selectClass = "w-full min-w-0 rounded border-2 border-black bg-white p-2 text-xs text-black";

export function SelectionOperationDialog({
  operation,
  inputs: initialInputs,
  onRun,
  onClose,
}: TLUiDialogProps & {
  operation: SelectionOperation;
  inputs: SQLDependencyShape[];
  onRun: (inputIds: SQLDependencyShape["id"][], keys: KeyMapping[]) => void;
}) {
  const [inputs, setInputs] = useState(initialInputs);
  const [useKeys, setUseKeys] = useState(operation === "JOIN");
  const [keys, setKeys] = useState<KeyMapping[]>([inputs.map(() => "")]);
  const needsKeys = operation === "JOIN" || (operation === "DIFF" && useKeys);
  let error: string | null = null;
  try {
    buildSelectionQuery(operation, inputs, needsKeys ? keys : []);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  const swapInputs = () => {
    setInputs([...inputs].reverse());
    setKeys(keys.map((mapping) => [...mapping].reverse()));
  };

  return (
    <div style={{ background: "#fff", color: "#000", border: "2px solid #000", borderRadius: 8 }}>
      <TldrawUiDialogHeader>
        <TldrawUiDialogTitle>
          {operation === "JOIN" ? "Join datasets" : operation === "DIFF" ? "Compare datasets" : "Subtract datasets"}
        </TldrawUiDialogTitle>
        <TldrawUiDialogCloseButton />
      </TldrawUiDialogHeader>
      <TldrawUiDialogBody
        style={{ display: "flex", flexDirection: "column", gap: 16, maxHeight: "65vh", overflowY: "auto" }}
      >
        <p style={{ margin: 0, fontSize: 13 }}>
          {operation === "JOIN"
            ? "Choose columns whose values match. An inner join keeps matching rows from every input; output columns are prefixed by input number."
            : operation === "DIFF"
              ? "Compare A (before) with B (after). Choose a key to find changed records, or compare whole rows to find additions and removals."
              : "Keep rows in A that are absent from every other selected dataset. Duplicate rows are removed. Columns match by position."}
        </p>
        {operation === "EXCEPT" ? (
          <>
            <label style={{ display: "grid", gap: 6, fontSize: 12, fontWeight: 700 }}>
              A — keep rows from
              <select
                className={selectClass}
                value={inputs[0].id}
                onChange={(event) => {
                  const first = inputs.find((input) => input.id === event.currentTarget.value)!;
                  setInputs([first, ...inputs.filter((input) => input.id !== first.id)]);
                }}
              >
                {inputs.map((input) => (
                  <option key={input.id} value={input.id}>
                    {input.props.name}
                  </option>
                ))}
              </select>
            </label>
            <p style={{ margin: 0, fontSize: 12 }}>
              Subtract:{" "}
              {inputs
                .slice(1)
                .map((input) => input.props.name)
                .join(", ")}
            </p>
          </>
        ) : (
          <div style={{ display: "grid", gap: 6, fontSize: 12 }}>
            {inputs.map((input, index) => (
              <div key={input.id} style={{ overflowWrap: "anywhere" }}>
                <strong>
                  {operation === "DIFF" ? (index === 0 ? "A (before)" : "B (after)") : `Input ${index + 1}`}:{" "}
                </strong>
                {input.props.name}
              </div>
            ))}
            {operation === "DIFF" && (
              <button type="button" className={`${buttonClass} bg-white`} onClick={swapInputs}>
                <ArrowDownUp size={14} /> Swap A and B
              </button>
            )}
          </div>
        )}
        {operation === "DIFF" && (
          <label style={{ display: "grid", gap: 6, fontSize: 12, fontWeight: 700 }}>
            Compare using
            <select
              className={selectClass}
              value={useKeys ? "keys" : "rows"}
              onChange={(event) => setUseKeys(event.currentTarget.value === "keys")}
            >
              <option value="rows">Whole rows — added / removed</option>
              <option value="keys">Matching keys — added / removed / changed</option>
            </select>
          </label>
        )}
        {needsKeys && (
          <div style={{ display: "grid", gap: 12 }}>
            {keys.map((mapping, keyIndex) => (
              <fieldset
                key={keyIndex}
                style={{ display: "grid", gap: 8, padding: 10, border: "2px solid #000", borderRadius: 6 }}
              >
                <legend style={{ fontSize: 12, fontWeight: 700 }}>Matching key {keyIndex + 1}</legend>
                {inputs.map((input, inputIndex) => (
                  <label key={input.id} style={{ display: "grid", gap: 4, fontSize: 12 }}>
                    {input.props.name}
                    <select
                      className={selectClass}
                      aria-label={`Key ${keyIndex + 1} for ${input.props.name}`}
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
                      <option value="">Choose a column</option>
                      {getSelectionSchema(input)?.map((column) => (
                        <option key={column.name} value={column.name}>
                          {column.name} ({column.type})
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
                {keys.length > 1 && (
                  <button
                    type="button"
                    className={`${buttonClass} bg-white`}
                    onClick={() => setKeys(keys.filter((_, index) => index !== keyIndex))}
                  >
                    <X size={14} /> Remove key
                  </button>
                )}
              </fieldset>
            ))}
            <button
              type="button"
              className={`${buttonClass} bg-white`}
              onClick={() => setKeys([...keys, inputs.map(() => "")])}
            >
              <Plus size={14} /> Add matching key
            </button>
            {operation === "DIFF" && (
              <p style={{ margin: 0, fontSize: 12 }}>
                Keys must uniquely identify a record in each dataset. Changed rows show before and after values; null
                values compare equally. Adding or removing a non-key column marks matching records as changed.
              </p>
            )}
          </div>
        )}
        {operation === "DIFF" && !useKeys && (
          <p style={{ margin: 0, fontSize: 12 }}>
            Whole-row comparison uses distinct rows with the same columns in the same order. Edits appear as one removal
            and one addition.
          </p>
        )}
        {error && (
          <p role="status" style={{ margin: 0, fontSize: 12, color: "#b91c1c" }}>
            {error}
          </p>
        )}
      </TldrawUiDialogBody>
      <TldrawUiDialogFooter>
        <button type="button" className={`${buttonClass} bg-white`} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={`${buttonClass} bg-yellow-100 hover:bg-yellow-200`}
          disabled={Boolean(error)}
          onClick={() => {
            onClose();
            onRun(
              inputs.map((input) => input.id),
              needsKeys ? keys : []
            );
          }}
        >
          Create and run
        </button>
      </TldrawUiDialogFooter>
    </div>
  );
}
