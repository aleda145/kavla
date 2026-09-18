import { createShapePropsMigrationIds, createShapePropsMigrationSequence } from "tldraw";

const versions = createShapePropsMigrationIds("summary-shape", {
  Init: 1,
});

export const SummaryShapeMigrations = createShapePropsMigrationSequence({
  sequence: [
    {
      id: versions.Init,
      up(props) {
        props.w = props.w ?? 560;
        props.h = props.h ?? 680;
        props.name = props.name ?? "Summary";
        props.question = props.question ?? "";
        props.answer = props.answer ?? "";
        props.sections = props.sections ?? [];
        props.artifacts = props.artifacts ?? [];
        props.sourceJobId = props.sourceJobId ?? null;
        props.agentShapeId = props.agentShapeId ?? null;
      },
      down(_props) {},
    },
  ],
});
