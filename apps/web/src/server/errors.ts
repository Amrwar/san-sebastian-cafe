import { ZodError } from "zod";

/**
 * Typed application errors. Services throw these; the HTTP layer maps them to RFC 9457
 * problem responses and UI layers map `code` to localized messages. `message` is for logs
 * and developers, never shown verbatim to customers.
 */
export type AppErrorCode =
  | "validation_failed"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "internal";

const STATUS: Record<AppErrorCode, number> = {
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  internal: 500,
};

export interface FieldIssue {
  path: string;
  code: string;
}

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: AppErrorCode,
    message: string,
    readonly fieldIssues: FieldIssue[] = [],
  ) {
    super(message);
    this.name = "AppError";
    this.status = STATUS[code];
  }
}

export const unauthenticated = () => new AppError("unauthenticated", "Authentication required");
export const forbidden = (permission: string) =>
  new AppError("forbidden", `Missing permission ${permission}`);
export const notFound = (what: string) => new AppError("not_found", `${what} not found`);

export function fromZodError(error: ZodError): AppError {
  return new AppError(
    "validation_failed",
    "Request validation failed",
    error.issues.map((i) => ({ path: i.path.join("."), code: i.code })),
  );
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: AppErrorCode;
  requestId: string;
  errors?: FieldIssue[];
}

/** Converts any thrown value into a safe problem document. Unknown errors never leak details. */
export function toProblem(error: unknown, requestId: string): ProblemDetails {
  const appError =
    error instanceof AppError
      ? error
      : error instanceof ZodError
        ? fromZodError(error)
        : new AppError("internal", "Unexpected error");
  return {
    type: `https://san-sebastian.invalid/problems/${appError.code}`,
    title: appError.code === "internal" ? "Internal server error" : appError.message,
    status: appError.status,
    code: appError.code,
    requestId,
    ...(appError.fieldIssues.length > 0 ? { errors: appError.fieldIssues } : {}),
  };
}
