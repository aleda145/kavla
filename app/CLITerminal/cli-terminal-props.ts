import { RecordProps, T } from "tldraw";
import { CLITerminalShape } from "./cli-terminal-types";

export const CLITerminalProps: RecordProps<CLITerminalShape> = {
  w: T.number,
  h: T.number,
};
