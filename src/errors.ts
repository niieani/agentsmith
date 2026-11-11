/**
 * Failure categories with distinct process exit codes, so schedulers and
 * monitoring can react to a failed run without parsing messages.
 */
export const EXIT_CODES = {
  success: 0,
  failure: 1,
  config: 2,
  "source-dirty": 3,
  "source-pull": 4,
  "artifact-modified": 5,
  "status-stale": 6,
} as const;

export type ErrorCode = Exclude<keyof typeof EXIT_CODES, "success">;

export class AgentsmithError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AgentsmithError";
    this.code = code;
  }

  get exitCode(): number {
    return EXIT_CODES[this.code];
  }
}

export function errorCode(cause: unknown): ErrorCode {
  return cause instanceof AgentsmithError ? cause.code : "failure";
}

export function exitCodeFor(cause: unknown): number {
  return EXIT_CODES[errorCode(cause)];
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Run an operation and reclassify untyped failures under one category. */
export async function classify<T>(code: ErrorCode, operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    if (cause instanceof AgentsmithError) throw cause;
    throw new AgentsmithError(code, errorMessage(cause), { cause });
  }
}
