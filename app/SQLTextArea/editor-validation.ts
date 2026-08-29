import { validate } from "@polyglot-sql/sdk";

export type EditorValidationIssue = {
  message: string;
  line?: number;
  column?: number;
  from?: number;
  to?: number;
};

export function validateDuckDBSyntax(sql: string): EditorValidationIssue | null {
  const result = validate(sql, "duckdb", {
    semantic: false,
    strictSyntax: false,
    dialectStrict: false,
  });

  const error = result.errors.find((issue) => issue.severity === "error");
  if (!error) {
    return null;
  }

  return {
    message: error.message,
    line: error.line,
    column: error.column,
    from: error.start,
    to: error.end,
  };
}

export function issueFromMessage(message: string): EditorValidationIssue {
  const issue: EditorValidationIssue = { message };

  const lineMatch = message.match(/LINE\s*:?\s*(\d+)/i);
  if (lineMatch) {
    issue.line = parseInt(lineMatch[1], 10);
  }

  return issue;
}

export function issueFromUnknownError(error: unknown): EditorValidationIssue {
  if (error instanceof Error) {
    return issueFromMessage(error.message || String(error));
  }

  return issueFromMessage(String(error));
}
