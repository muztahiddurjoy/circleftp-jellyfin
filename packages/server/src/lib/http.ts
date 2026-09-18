/** Small Express helpers shared by every route module. */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType, ZodTypeDef } from 'zod';

import { ApiError } from './errors.js';

/**
 * Express 5 forwards rejected promises to the error middleware on its own, but
 * wrapping keeps the intent explicit and survives a downgrade.
 */
export function asyncHandler<T extends RequestHandler>(handler: T): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/** Validate `req.body` against a schema, turning zod issues into a 400. */
export function parseBody<T>(schema: ZodType<T, ZodTypeDef, unknown>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw ApiError.badRequest('Check the highlighted fields', flattenIssues(result.error.issues));
  }
  return result.data;
}

/** Validate `req.query` against a schema, turning zod issues into a 400. */
export function parseQuery<T>(schema: ZodType<T, ZodTypeDef, unknown>, query: unknown): T {
  const result = schema.safeParse(query);
  if (!result.success) {
    throw ApiError.badRequest('Invalid request', flattenIssues(result.error.issues));
  }
  return result.data;
}

function flattenIssues(
  issues: { path: (string | number)[]; message: string }[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = issue.path.join('.') || '_';
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

/** Turn any thrown value into the documented error envelope. */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const apiError =
    err instanceof ApiError
      ? err
      : // Unknown failures are bugs: log the detail, tell the client nothing.
        ApiError.internal();

  if (!(err instanceof ApiError) || apiError.status >= 500) {
    req.log?.error({ err }, 'Unhandled error');
  }

  res.status(apiError.status).json({
    error: {
      code: apiError.code,
      message: apiError.message,
      ...(apiError.details ? { details: apiError.details } : {}),
    },
  });
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'not_found', message: 'No such endpoint' } });
}
