import { EditorView, Tooltip, showTooltip } from "@codemirror/view";
import { StateField, StateEffect, Extension } from "@codemirror/state";
import { ViewPlugin, ViewUpdate } from "@codemirror/view";

export type HoverSource = (view: EditorView, pos: number, side: number) => Tooltip | null;
export const INTERACTIVE_HOVER_TOOLTIP_CLASS = "kavla-interactive-hover-tooltip";

/**
 * A drop-in replacement for CodeMirror's `hoverTooltip` that adds a customizable
 * grace period (delay) before hiding the tooltip. This gives users time to move
 * their cursor across the gap into the tooltip without it instantly closing.
 * It accepts an array of sources to enforce priority (first matched source wins).
 */
export function gracePeriodHoverTooltip(
  sources: HoverSource[],
  options: { hoverTime?: number; hideDelay?: number } = {}
): Extension {
  const hoverTime = options.hoverTime ?? 300;
  const hideDelay = options.hideDelay ?? 300;

  const setHoverTooltip = StateEffect.define<Tooltip | null>();

  const hoverTooltipField = StateField.define<Tooltip | null>({
    create() {
      return null;
    },
    update(tooltip, tr) {
      for (const e of tr.effects) {
        if (e.is(setHoverTooltip)) return e.value;
      }
      if (tr.docChanged) return null; // Clear on type
      return tooltip;
    },
    provide: (f) => showTooltip.from(f),
  });

  const hoverPlugin = ViewPlugin.fromClass(
    class {
      hoverTimeout: NodeJS.Timeout | null = null;
      hideTimeout: NodeJS.Timeout | null = null;
      lastMouseEvent: MouseEvent | null = null;
      activeTooltipObj: Tooltip | null = null;

      constructor(public view: EditorView) {
        // Tooltips may render outside view.dom, so pointer tracking must be global.
        document.addEventListener("mousemove", this.handleMouseMove);
        view.scrollDOM.addEventListener("scroll", this.handleScroll);
      }

      destroy() {
        this.clearTimeouts();
        document.removeEventListener("mousemove", this.handleMouseMove);
        this.view.scrollDOM.removeEventListener("scroll", this.handleScroll);
      }

      update(update: ViewUpdate) {
        if (update.docChanged && this.activeTooltipObj) {
          this.clearTimeouts();
          this.activeTooltipObj = null;
        }
      }

      handleScroll = () => {
        this.clearTooltip();
      };

      clearTimeouts() {
        if (this.hoverTimeout) clearTimeout(this.hoverTimeout);
        if (this.hideTimeout) clearTimeout(this.hideTimeout);
        this.hoverTimeout = null;
        this.hideTimeout = null;
      }

      clearTooltip() {
        this.clearTimeouts();
        if (this.activeTooltipObj) {
          this.activeTooltipObj = null;
          requestAnimationFrame(() => {
            this.view.dispatch({ effects: setHoverTooltip.of(null) });
          });
        }
      }

      handleMouseMove = (e: MouseEvent) => {
        this.lastMouseEvent = e;
        const target = e.target instanceof Element ? e.target : null;

        if (target?.closest(`.cm-tooltip, .${INTERACTIVE_HOVER_TOOLTIP_CLASS}`)) {
          if (this.hideTimeout) {
            clearTimeout(this.hideTimeout);
            this.hideTimeout = null;
          }
          if (this.hoverTimeout) {
            clearTimeout(this.hoverTimeout);
            this.hoverTimeout = null;
          }
          return;
        }

        if (this.activeTooltipObj) {
          const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY });
          let isStillOverTrigger = false;

          if (pos !== null) {
            const charWidth = this.view.defaultCharacterWidth;
            const posCoords = this.view.coordsAtPos(pos);
            if (
              posCoords &&
              e.clientY >= posCoords.top - 4 &&
              e.clientY <= posCoords.bottom + 4 &&
              e.clientX >= posCoords.left - charWidth * 1.5 &&
              e.clientX <= posCoords.right + charWidth * 1.5
            ) {
              const start = this.activeTooltipObj.pos;
              const end = this.activeTooltipObj.end ?? this.activeTooltipObj.pos;
              if (pos >= start && pos <= end) {
                isStillOverTrigger = true;
              }
            }
          }

          if (isStillOverTrigger) {
            if (this.hideTimeout) {
              clearTimeout(this.hideTimeout);
              this.hideTimeout = null;
            }
            if (this.hoverTimeout) {
              clearTimeout(this.hoverTimeout);
              this.hoverTimeout = null;
            }
            return;
          } else {
            if (!this.hideTimeout) {
              this.hideTimeout = setTimeout(() => {
                this.clearTooltip();
              }, hideDelay);
            }
          }
        }

        if (this.hoverTimeout) clearTimeout(this.hoverTimeout);

        this.hoverTimeout = setTimeout(this.checkHover, hoverTime);
      };

      checkHover = () => {
        if (!this.lastMouseEvent) return;
        const e = this.lastMouseEvent;

        if (!this.view.dom.contains(e.target as Node)) {
          return;
        }

        const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos === null) return;

        const charWidth = this.view.defaultCharacterWidth;
        const posCoords = this.view.coordsAtPos(pos);
        if (!posCoords) return;

        if (
          e.clientY < posCoords.top - 4 ||
          e.clientY > posCoords.bottom + 4 ||
          e.clientX < posCoords.left - charWidth * 1.5 ||
          e.clientX > posCoords.right + charWidth * 1.5
        ) {
          return;
        }

        let newTooltipObj: Tooltip | null = null;
        for (const source of sources) {
          newTooltipObj = source(this.view, pos, 1);
          if (newTooltipObj) break;
        }

        if (newTooltipObj) {
          this.clearTimeouts();
          this.activeTooltipObj = newTooltipObj;
          this.view.dispatch({ effects: setHoverTooltip.of(newTooltipObj) });
        }
      };
    }
  );

  return [hoverTooltipField, hoverPlugin];
}
