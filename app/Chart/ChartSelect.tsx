import { useEffect, useRef, useState, type FC } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { getColumnTypeColor } from "../util/column-colors";

interface ChartSelectProps {
  options: string[];
  optionTypes?: Record<string, string>;
  value: string | null;
  onSelect: (value: string) => void;
  title: string;
  placeholder?: string;
  disabled?: boolean;
}

export const ChartSelect: FC<ChartSelectProps> = ({
  options,
  optionTypes,
  value,
  onSelect,
  title,
  placeholder = "Select...",
  disabled = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [hoveredOption, setHoveredOption] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0 });

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const inContainer = containerRef.current && containerRef.current.contains(target);
      const inDropdown = dropdownRef.current && dropdownRef.current.contains(target);

      if (!inContainer && !inDropdown) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    const handleResize = () => setIsOpen(false);

    const handleScroll = (event: Event) => {
      const target = event.target as Node;
      if (dropdownRef.current && (target === dropdownRef.current || dropdownRef.current.contains(target))) {
        return;
      }
      setIsOpen(false);
    };

    window.addEventListener("resize", handleResize);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("wheel", handleScroll, true);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("wheel", handleScroll, true);
    };
  }, []);

  const handleOpen = () => {
    if (disabled || options.length === 0) return;
    if (!isOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setPosition({
        top: rect.bottom + 4,
        left: rect.left,
        width: rect.width,
      });
      setIsOpen(true);
    } else {
      setIsOpen(false);
    }
  };

  const buttonRef = useRef<HTMLButtonElement>(null);

  const handleSelect = (option: string) => {
    onSelect(option);
    setTimeout(() => setIsOpen(false), 100);
  };

  const dropdownToRender = isOpen
    ? createPortal(
        <div
          ref={dropdownRef}
          onPointerDown={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
          style={{
            position: "fixed",
            top: position.top,
            left: position.left,
            width: position.width,
            backgroundColor: "white",
            border: "2px solid #000",
            zIndex: 9999999,
            borderRadius: 4,
            boxShadow: "4px 4px 0px 0px rgba(0,0,0,1)",
            maxHeight: 200,
            overflowY: "auto",
          }}
        >
          {options.map((option) => {
            const hasColor = optionTypes && optionTypes[option] && option !== "None";
            const colorClass = hasColor ? getColumnTypeColor(optionTypes[option]) : "";
            const isHovered = hoveredOption === option;

            return (
              <button
                key={option}
                title={optionTypes && optionTypes[option] ? `${option} (${optionTypes[option]})` : option}
                onClick={() => handleSelect(option)}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  if (event.pointerType === "touch") {
                    handleSelect(option);
                  }
                }}
                onMouseEnter={() => setHoveredOption(option)}
                onMouseLeave={() => setHoveredOption(null)}
                className={colorClass}
                style={{
                  touchAction: "none",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  width: "100%",
                  border: "none",
                  borderBottom: "1px solid #000",
                  padding: "6px 8px",
                  textAlign: "left",
                  backgroundColor: colorClass ? undefined : "white",
                  filter: isHovered ? "brightness(0.95)" : "none",
                  cursor: "pointer",
                  fontWeight: "bold",
                  fontSize: 12,
                }}
              >
                <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{option}</span>
              </button>
            );
          })}
        </div>,
        document.body
      )
    : null;

  return (
    <div ref={containerRef} style={{ position: "relative", flex: 1, minWidth: 0 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: "bold",
          marginBottom: 2,
          textTransform: "uppercase",
          color: "#444",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {title}
      </div>
      <button
        ref={buttonRef}
        title={value && optionTypes && optionTypes[value] ? `${value} (${optionTypes[value]})` : value || undefined}
        onClick={handleOpen}
        onPointerDown={(event) => {
          event.stopPropagation();
          if (event.pointerType === "touch") {
            handleOpen();
          }
        }}
        className={
          value && optionTypes && optionTypes[value] && value !== "None" ? getColumnTypeColor(optionTypes[value]) : ""
        }
        disabled={disabled || options.length === 0}
        style={{
          touchAction: "none",
          width: "100%",
          textAlign: "left",
          border: "2px solid #000",
          padding: "4px 8px",
          backgroundColor: value && optionTypes && optionTypes[value] && value !== "None" ? undefined : "white",
          borderRadius: "4px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontWeight: "bold",
          fontSize: 12,
          cursor: disabled || options.length === 0 ? "not-allowed" : "pointer",
          opacity: disabled || options.length === 0 ? 0.6 : 1,
          height: 32,
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
          {value || placeholder}
        </span>
        <ChevronDown size={14} style={{ flexShrink: 0, marginLeft: 4 }} />
      </button>
      {dropdownToRender}
    </div>
  );
};
