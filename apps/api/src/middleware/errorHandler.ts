import type { Request, Response, NextFunction } from 'express';
import { HTTP_STATUS } from '@peerlume/shared';
import { sendError } from '../utils/apiResponse.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(message: string, statusCode: number = HTTP_STATUS.INTERNAL_SERVER_ERROR, code: string = 'INTERNAL_ERROR', details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export function errorHandler(
  err: Error | AppError,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
): void {
  const isAppError = err instanceof AppError;
  const isMulterError = err.name === 'MulterError';
  const statusCode = isAppError
    ? err.statusCode
    : isMulterError
      ? HTTP_STATUS.BAD_REQUEST
      : HTTP_STATUS.INTERNAL_SERVER_ERROR;
  const code = isAppError
    ? err.code
    : isMulterError
      ? 'FILE_UPLOAD_ERROR'
      : 'INTERNAL_SERVER_ERROR';

  // Sanitize message in production to prevent leaking sensitive internals
  const isProduction = env.NODE_ENV === 'production';
  const message = isAppError || isMulterError
    ? err.message
    : isProduction
      ? 'An unexpected internal server error occurred'
      : err.message || 'Internal server error';

  const details = isAppError
    ? err.details
    : isProduction
      ? undefined
      : { stack: err.stack };

  logger.error(`Error handling ${req.method} ${req.originalUrl}: ${err.message}`, {
    name: err.name,
    code,
    statusCode,
    ...(isProduction ? {} : { stack: err.stack }),
  });

  sendError(res, statusCode, code, message, details);
}
