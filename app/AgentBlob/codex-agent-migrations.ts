import { createShapePropsMigrationIds, createShapePropsMigrationSequence } from "tldraw";

const versions = createShapePropsMigrationIds("codex-agent", { Init: 1, Overlay: 2 });

export const CodexAgentMigrations = createShapePropsMigrationSequence({
  sequence: [{
    id: versions.Init,
    up(props) {
      props.w = props.w ?? 370;
      props.h = props.h ?? 500;
      props.name = props.name ?? "Codex";
      props.entries = props.entries ?? [];
      props.codexThreadId = props.codexThreadId ?? null;
      props.isRunning = false;
      props.streamingText = "";
      props.activity = null;
    },
    down(_props) {},
  }, {
    id: versions.Overlay,
    up(props) {
      props.isOpen = props.isOpen ?? false;
    },
    down(props) {
      delete props.isOpen;
    },
  }],
});
