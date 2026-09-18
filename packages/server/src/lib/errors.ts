/**
 * The one error type route handlers throw.
 *
 * Anything else reaching the error middleware is treated as a bug and reported
 * as a generic 500 without leaking its message to the client.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, string[]> | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: Record<string, string[]>): ApiError {
    return new ApiError(400, 'bad_request', message, details);
  }

  static unauthorized(message = 'You need to sign in to do that'): ApiError {
    return new ApiError(401, 'unauthorized', message);
  }

  static forbidden(message = 'You do not have access to that'): ApiError {
    return new ApiError(403, 'forbidden', message);
  }

  static notFound(message = 'Not found'): ApiError {
    return new ApiError(404, 'not_found', message);
  }

  static conflict(code: string, message: string): ApiError {
    return new ApiError(409, code, message);
  }

  static tooManyRequests(message = 'Too many attempts. Try again shortly.'): ApiError {
    return new ApiError(429, 'rate_limited', message);
  }

  /** The upstream Circle FTP API failed us, not the client. */
  static upstream(message: string): ApiError {
    return new ApiError(502, 'upstream_error', message);
  }

  static internal(message = 'Something went wrong'): ApiError {
    return new ApiError(500, 'internal_error', message);
  }
}
