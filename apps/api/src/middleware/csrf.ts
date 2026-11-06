import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { HTTP_STATUS } from '@peerlume/shared';
import { sendError } from '../utils/apiResponse.js';
import { COOKIE_ACCESS_NAME, COOKIE_REFRESH_NAME } from '../utils/cookies.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Checks whether an incoming origin string is in the authorized origins list.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  if (origin === env.WEB_ORIGIN) return true;
  if (env.NODE_ENV === 'development' || env.NODE_ENV === 'test') {
    if (/^http:\/\/localhost:(5173|5174|5175)$/.test(origin)) return true;
  }
  return false;
}

/**
 * CSRF Protection Middleware for cross-origin deployments (Vercel <-> Render).
 *
 * Browsers send SameSite=None cookies on cross-origin requests.
 * For mutating HTTP methods (POST, PUT, PATCH, DELETE) that rely on automatic
 * cookie authentication, this middleware verifies that the browser-supplied
 * Origin or Referer matches the trusted client origin.
 *
 * Requests authenticated via Authorization Bearer headers (e.g. mobile, cURL)
 * are exempt because browsers never attach Authorization headers cross-origin automatically.
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  // Safe read-only HTTP methods are exempt from CSRF checks
  if (SAFE_METHODS.has(req.method.toUpperCase())) {
    return next();
  }

  // Check if request is authenticated using browser-managed cookies
  const hasAuthCookie = Boolean(
    req.cookies?.[COOKIE_ACCESS_NAME] || req.cookies?.[COOKIE_REFRESH_NAME]
  );

  // If the request does not carry auth cookies, CSRF via ambient credentials is not possible
  if (!hasAuthCookie) {
    return next();
  }

  // For cookie-authenticated mutating requests, inspect Origin or Referer header
  let requestOrigin: string | undefined = req.headers.origin;
  if (!requestOrigin && req.headers.referer) {
    try {
      requestOrigin = new URL(req.headers.referer).origin;
    } catch {
      requestOrigin = 'invalid';
    }
  }

  // In test environments, allow requests without an explicit Origin header
  // unless an untrusted/forbidden origin was explicitly set
  if (env.NODE_ENV === 'test' && !requestOrigin) {
    return next();
  }

  if (!requestOrigin || !isAllowedOrigin(requestOrigin)) {
    sendError(
      res,
      HTTP_STATUS.FORBIDDEN,
      'CSRF_FORBIDDEN',
      'Cross-site request forgery protection: Untrusted or missing request origin'
    );
    return;
  }

  next();
}

