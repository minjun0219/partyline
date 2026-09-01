// Flat error shape shared by every endpoint (SPEC.md §2).

export type ErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "not_found"
  | "name_taken"
  | "no_such_recipient"
  | "inbox_full"
  | "gone"
  | "too_large"
  | "rate_limited"
  | "internal";

export const ERROR_STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  not_found: 404,
  name_taken: 409,
  no_such_recipient: 409,
  inbox_full: 409,
  gone: 410,
  too_large: 413,
  rate_limited: 429,
  internal: 500,
};

export interface ErrorBody {
  error: ErrorCode;
  message: string;
}

export function errorBody(error: ErrorCode, message: string): ErrorBody {
  return { error, message };
}

/** Result shape Durable Objects return to the worker over RPC. */
export type Fail = { ok: false; error: ErrorCode; message: string };

export function fail(error: ErrorCode, message: string): Fail {
  return { ok: false, error, message };
}
