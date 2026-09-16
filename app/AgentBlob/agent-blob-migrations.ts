import { createShapePropsMigrationIds, createShapePropsMigrationSequence } from "tldraw";

const versions = createShapePropsMigrationIds("agent-blob", {
  Init: 1,
});

export const AgentBlobMigrations = createShapePropsMigrationSequence({
  sequence: [
    {
      id: versions.Init,
      up(props) {
        props.w = props.w ?? 96;
        props.h = props.h ?? 88;
        props.name = props.name ?? "Analyst";
        props.status = props.status ?? "idle";
        props.currentJobId = props.currentJobId ?? null;
        props.lastMessage = props.lastMessage ?? null;
        props.targetShapeIds = props.targetShapeIds ?? null;
        props.createdAt = props.createdAt ?? Date.now();
        props.lastFinishedAt = props.lastFinishedAt ?? null;
      },
      down(_props) {},
    },
  ],
});
