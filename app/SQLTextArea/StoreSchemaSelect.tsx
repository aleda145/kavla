import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Plus } from "lucide-react";

interface StoreSchemaSelectProps {
  options: string[];
  value: string;
  title: string;
  placeholder: string;
  disabled: boolean;
  onSelect: (value: string) => void;
  onCreate: () => void;
}

// Kept local to Store: the chart picker has its own canvas-specific behavior.
export function StoreSchemaSelect({
  options,
  value,
  title,
  placeholder,
  disabled,
  onSelect,
  onCreate,
}: StoreSchemaSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const [position, setPosition] = useState<{
    top?: number;
    bottom?: number;
    left: number;
    width: number;
    maxHeight: number;
  }>({ top: 0, left: 0, width: 0, maxHeight: 200 });

  useEffect(() => {
    if (!isOpen) return;
    const handleOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!containerRef.current?.contains(target) && !dropdownRef.current?.contains(target)) setIsOpen(false);
    };
    const handleScroll = (event: Event) => {
      if (!dropdownRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    const handleResize = () => setIsOpen(false);
    document.addEventListener("pointerdown", handleOutside, true);
    window.addEventListener("resize", handleResize);
    window.addEventListener("scroll", handleScroll, true);
    const selected = dropdownRef.current?.querySelector<HTMLButtonElement>('[aria-current="true"]');
    (selected ?? dropdownRef.current?.querySelector<HTMLButtonElement>("button"))?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("pointerdown", handleOutside, true);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [isOpen]);

  const open = () => {
    if (disabled || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const openAbove = below < 200 && above > below;
    setPosition({
      top: openAbove ? undefined : rect.bottom + 4,
      bottom: openAbove ? window.innerHeight - rect.top + 4 : undefined,
      left: rect.left,
      width: rect.width,
      maxHeight: Math.max(0, Math.min(200, openAbove ? above : below)),
    });
    setIsOpen(true);
  };

  const close = () => {
    setIsOpen(false);
    buttonRef.current?.focus({ preventScroll: true });
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const buttons = Array.from(dropdownRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else if (event.key === "Tab") {
      close();
    }
  };

  return (
    <div ref={containerRef} style={{ minWidth: 0 }}>
      <div id={`${id}-label`} className="mb-1 text-[11px] font-black uppercase">
        {title}
      </div>
      <button
        ref={buttonRef}
        type="button"
        aria-labelledby={`${id}-label ${id}-value`}
        aria-haspopup="menu"
        aria-expanded={isOpen && !disabled}
        aria-controls={isOpen && !disabled ? `${id}-menu` : undefined}
        disabled={disabled}
        onClick={() => (isOpen ? close() : open())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            open();
          }
        }}
        className="flex h-9 w-full items-center justify-between gap-2 rounded border-2 border-black bg-white px-2 text-left text-xs font-bold cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span id={`${id}-value`} className="truncate">
          {value || placeholder}
        </span>
        <ChevronDown aria-hidden="true" size={14} className="shrink-0" />
      </button>
      {isOpen &&
        !disabled &&
        createPortal(
          <div
            ref={dropdownRef}
            id={`${id}-menu`}
            role="menu"
            aria-labelledby={`${id}-label`}
            onKeyDown={handleMenuKeyDown}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
            style={{
              position: "fixed",
              ...position,
              backgroundColor: "white",
              border: "2px solid #000",
              zIndex: 9999999,
              borderRadius: 4,
              boxShadow: "4px 4px 0px 0px rgba(0,0,0,1)",
              overflowY: "auto",
            }}
          >
            {options.map((option) => (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                aria-checked={value === option}
                aria-current={value === option ? "true" : undefined}
                title={option}
                onClick={() => {
                  close();
                  onSelect(option);
                }}
                className="flex w-full items-center justify-between gap-2 border-b border-black bg-white px-2 py-1.5 text-left text-xs font-bold hover:bg-gray-100 focus:bg-gray-100 cursor-pointer"
              >
                <span className="truncate">{option}</span>
                {value === option && <Check aria-hidden="true" size={14} className="shrink-0" />}
              </button>
            ))}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setIsOpen(false);
                onCreate();
              }}
              className="flex w-full items-center gap-2 bg-blue-50 px-2 py-1.5 text-left text-xs font-bold hover:bg-blue-100 focus:bg-blue-100 cursor-pointer"
            >
              <Plus aria-hidden="true" size={14} /> Create {title.toLowerCase()}
            </button>
          </div>,
          buttonRef.current?.closest("dialog") ?? document.body
        )}
    </div>
  );
}
