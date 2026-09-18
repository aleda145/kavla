import {
  EmptyState,
  Footer,
  Frame,
  Legend,
  Palette,
  Tooltip,
  formatValue,
  getCategoricalColors,
  getMargins,
  useHover,
} from "./primitives";

export type LensVizRuntime = {
  Frame: typeof Frame;
  Legend: typeof Legend;
  Tooltip: typeof Tooltip;
  EmptyState: typeof EmptyState;
  Footer: typeof Footer;
  Palette: typeof Palette;
  formatValue: typeof formatValue;
  getCategoricalColors: typeof getCategoricalColors;
  useHover: typeof useHover;
  getMargins: typeof getMargins;
};

export function getLensVizRuntime(): LensVizRuntime {
  return {
    Frame,
    Legend,
    Tooltip,
    EmptyState,
    Footer,
    Palette,
    formatValue,
    getCategoricalColors,
    useHover,
    getMargins,
  };
}
