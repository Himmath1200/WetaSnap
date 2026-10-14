/**
 * One error type for anything a person could reasonably be told, and one filter that turns
 * everything else into a short, honest sentence. Nothing that reaches a browser ever carries a
 * stack, a SQL statement, a column name or a token.
 */
import {
  ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/** An error with a message the app is meant to show as it is. */
export class DomainError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    /** A short machine code the app can branch on, e.g. 'seats_exhausted', 'scan_limit'. */
    readonly code?: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const notFound = (what: string) => new DomainError(`${what} no longer exists.`, 404, 'not_found');
export const forbidden = (why = 'You do not have permission to do this.') => new DomainError(why, 403, 'forbidden');
export const unauthorized = (why = 'Please sign in again.') => new DomainError(why, 401, 'unauthorized');

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger('Api');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Something went wrong. Please try again.';
    let code: string | undefined;

    if (exception instanceof DomainError) {
      status = exception.status;
      message = exception.message;
      code = exception.code;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse() as string | { message?: string | string[]; code?: string };
      const raw = typeof body === 'string' ? body : Array.isArray(body.message) ? body.message[0] : body.message;
      message = raw ?? exception.message;
      code = typeof body === 'object' ? body.code : undefined;
    }

    // Anything unexpected is logged in full for us and summarised for them.
    if (status >= 500) {
      this.log.error(`${req.method} ${req.url} — ${(exception as Error)?.message}`, (exception as Error)?.stack);
    } else {
      this.log.warn(`${req.method} ${req.url} — ${status} ${message}`);
    }

    res.status(status).json({ error: message, ...(code ? { code } : {}) });
  }
}
