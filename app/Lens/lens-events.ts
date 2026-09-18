import type { SyntheticEvent } from "react";

export function stopLensWidgetEventPropagation(event: SyntheticEvent) {
  event.stopPropagation();
}
