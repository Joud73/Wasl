import "server-only";

type ErrorLike = { code?: unknown; message?: unknown; hint?: unknown };

const MAX_MESSAGE = 300;

function scalar(value: unknown): string | number | undefined {
  if (typeof value === "string") return value.slice(0, MAX_MESSAGE);
  if (typeof value === "number") return value;
  return undefined;
}

/**
 * Logs the real cause of a failure on the server. Users only ever see a generic message.
 * Only the error's code, message and hint are logged: never details, stack, payloads or the
 * whole object, which can carry user content. Never pass secrets or user text in `context`.
 */
export function logServerError(where: string, error: unknown, context?: Record<string, unknown>) {
  const e = (typeof error === "object" && error !== null ? error : {}) as ErrorLike;
  console.error(`[${where}]`, {
    code: scalar(e.code),
    message: typeof error === "string" ? scalar(error) : scalar(e.message),
    hint: scalar(e.hint),
    ...context,
  });
}
