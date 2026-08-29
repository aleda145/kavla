import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";

import { TldrawUiToastsProvider } from "tldraw";
import LocalKavlaApp from "./local/LocalKavlaApp";

const CANVAS_ACTIVE_CLASS = "room-canvas-active";
const ALLOW_MIDDLE_CLICK_ATTR = "data-allow-middle-click";

function shouldSuppressMiddleClick(event: MouseEvent) {
  if (event.button !== 1) {
    return false;
  }

  if (!document.body.classList.contains(CANVAS_ACTIVE_CLASS)) {
    return false;
  }

  return !event
    .composedPath()
    .some((target) => target instanceof Element && target.hasAttribute(ALLOW_MIDDLE_CLICK_ATTR));
}

// Prevent middle-click (scroll click) paste on Linux only while a canvas is active.
document.addEventListener(
  "mousedown",
  (e) => {
    if (shouldSuppressMiddleClick(e)) {
      e.preventDefault();
    }
  },
  { capture: true }
);
document.addEventListener(
  "auxclick",
  (e) => {
    if (shouldSuppressMiddleClick(e)) {
      e.preventDefault();
    }
  },
  { capture: true }
);

async function main() {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <TldrawUiToastsProvider>
        <LocalKavlaApp />
      </TldrawUiToastsProvider>
    </React.StrictMode>
  );
}

main();
