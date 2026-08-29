import { createShapePropsMigrationIds, createShapePropsMigrationSequence } from "tldraw";

const versions = createShapePropsMigrationIds("cli-terminal", {
  Init: 1,
});

export const CLITerminalMigrations = createShapePropsMigrationSequence({
  sequence: [
    {
      id: versions.Init,
      up(_props) {},
      down(_props) {},
    },
  ],
});
