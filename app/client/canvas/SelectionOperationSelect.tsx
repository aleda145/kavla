import { useId } from "react";
import { ChevronDown } from "lucide-react";
import {
  TldrawUiDropdownMenuRoot,
  TldrawUiDropdownMenuTrigger,
  TldrawUiDropdownMenuContent,
  TldrawUiDropdownMenuItem,
} from "tldraw";
import { getColumnTypeColor } from "../../util/column-colors";

type SelectionOption = { value: string; label: string; type?: string };

export function SelectionOperationSelect({
  options,
  value,
  label,
  onSelect,
}: {
  options: SelectionOption[];
  value: string;
  label: string;
  onSelect: (value: string) => void;
}) {
  const id = useId();
  const selected = options.find((option) => option.value === value);
  const color = selected?.type ? getColumnTypeColor(selected.type) : "";
  return (
    <div className="kavla-selection-select">
      <div className="kavla-selection-select-measure" aria-hidden="true">
        {["—", ...options.map((option) => option.label)].map((text, index) => (
          <span key={index} className="kavla-selection-select-trigger" data-selection-option-measure>
            <span>{text}</span>
            <ChevronDown size={14} />
          </span>
        ))}
      </div>
      <TldrawUiDropdownMenuRoot id={`selection-option-${id}`} modal={false}>
        <TldrawUiDropdownMenuTrigger>
          <button
            type="button"
            className={`kavla-selection-select-trigger ${color || "bg-white"}`}
            aria-label={label}
            title={selected?.type ? `${selected.label} (${selected.type})` : selected?.label || label}
            disabled={options.length === 0}
          >
            <span>{selected?.label || "—"}</span>
            <ChevronDown size={14} aria-hidden />
          </button>
        </TldrawUiDropdownMenuTrigger>
        <TldrawUiDropdownMenuContent
          className="kavla-selection-select-menu"
          side="bottom"
          align="start"
          sideOffset={4}
          alignOffset={0}
        >
          {options.map((option) => (
            <TldrawUiDropdownMenuItem key={option.value}>
              <button
                type="button"
                className={`kavla-selection-select-option ${option.type ? getColumnTypeColor(option.type) || "bg-white" : "bg-white"}`}
                title={option.type ? `${option.label} (${option.type})` : option.label}
                aria-label={option.type ? `${option.label} (${option.type})` : option.label}
                aria-current={option.value === value ? "true" : undefined}
                data-selected={option.value === value}
                onClick={() => onSelect(option.value)}
              >
                <span>{option.label}</span>
              </button>
            </TldrawUiDropdownMenuItem>
          ))}
        </TldrawUiDropdownMenuContent>
      </TldrawUiDropdownMenuRoot>
    </div>
  );
}
