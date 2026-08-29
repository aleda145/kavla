import type { CliOutputLine } from "./useLocalServer";

export type CliTerminalDisplayState =
  "connected-empty" | "connected-history" | "not-connected-empty" | "disconnected-history";
export type CliTerminalStatusTone = "connected" | "not-connected" | "disconnected";

export interface CliTerminalDisplay {
  state: CliTerminalDisplayState;
  tone: CliTerminalStatusTone;
  headerLabel: string;
  emptyStateText: string | null;
  outputText: string | null;
  hasHistory: boolean;
}

const CLI_EMPTY_STATE_TEXT = "Open this document with the Kavla CLI to use configured data sources.";

export function getCliTerminalDisplay(cliConnected: boolean, cliOutput: CliOutputLine[]): CliTerminalDisplay {
  const hasHistory = cliOutput.length > 0;

  if (cliConnected) {
    return {
      state: hasHistory ? "connected-history" : "connected-empty",
      tone: "connected",
      headerLabel: "connected",
      emptyStateText: hasHistory ? null : "Waiting for activity…",
      outputText: hasHistory ? cliOutput.map((entry) => entry.line).join("\n") : null,
      hasHistory,
    };
  }

  if (hasHistory) {
    return {
      state: "disconnected-history",
      tone: "disconnected",
      headerLabel: "disconnected",
      emptyStateText: null,
      outputText: cliOutput.map((entry) => entry.line).join("\n"),
      hasHistory,
    };
  }

  return {
    state: "not-connected-empty",
    tone: "not-connected",
    headerLabel: "not connected",
    emptyStateText: CLI_EMPTY_STATE_TEXT,
    outputText: null,
    hasHistory,
  };
}
