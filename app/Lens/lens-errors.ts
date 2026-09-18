export class LensRuntimeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LensRuntimeUnavailableError";
  }
}

export function isLensRuntimeUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof LensRuntimeUnavailableError || /content.security.policy|\bcsp\b|unsafe-eval|refused to (?:evaluate|execute|load|connect)|failed to fetch|fetching dynamically imported module|loading chunk|networkerror|webgl.*(?:unavailable|not supported)|failed to create.*webgl/i.test(message);
}
