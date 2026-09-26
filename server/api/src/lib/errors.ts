/**
 * Every error response has the same shape:
 *   { "error": { "code": "stable_snake_case", "message": "…", "details"?: … } }
 * Clients switch on `code`; `message` is for logs and developers.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message ?? code);
  }
}

export const badRequest = (code: string, message?: string, details?: unknown) => new ApiError(400, code, message, details);
export const unauthorized = (code = "unauthorized", message?: string) => new ApiError(401, code, message);
export const forbidden = (code = "forbidden", message?: string) => new ApiError(403, code, message);
export const notFound = (code = "not_found", message?: string) => new ApiError(404, code, message);
export const conflict = (code: string, message?: string) => new ApiError(409, code, message);
export const tooMany = (code: string, retryAfterSeconds: number) =>
  new ApiError(429, code, undefined, undefined, { "retry-after": String(retryAfterSeconds) });
export const notImplemented = (code: string, message?: string) => new ApiError(501, code, message);

/** PostgreSQL `unique_violation` (a concurrent insert won the race). */
export const isUniqueViolation = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";
