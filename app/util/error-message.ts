export function getErrorMessage(error: unknown, fallback = "Unknown error"): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : null;
  if (message?.trim()) {
    try {
      const parsedError: unknown = JSON.parse(message);
      if (
        typeof parsedError === "object" &&
        parsedError !== null &&
        "error" in parsedError &&
        typeof parsedError.error === "string"
      ) {
        return parsedError.error;
      }
    } catch {
      // The message is already plain text.
    }
    return message;
  }

  try {
    return JSON.stringify(error) ?? fallback;
  } catch {
    return fallback;
  }
}

export function getBriefErrorMessage(error: unknown, fallback = "Unknown error"): string {
  const firstLine = getErrorMessage(error, fallback)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  const message = (firstLine ?? fallback).replace(
    /^(?:Error:\s*)?(?:Catalog|Binder|Parser|Conversion|IO|Invalid Input) Error:\s*/i,
    ""
  );
  const missingTable = message.match(/^Table with name (.+?) does not exist!?$/i);

  return missingTable ? `Missing table: ${missingTable[1]}` : message;
}
