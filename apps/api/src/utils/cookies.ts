import type { CookieOptions, Response } from 'express';
import { env } from '../config/env.js';

export const COOKIE_ACCESS_NAME = 'peerlume_access_token';
export const COOKIE_REFRESH_NAME = 'peerlume_refresh_token';

// Expiration Durations
export const ACCESS_TOKEN_MAX_AGE_MS = 15 * 60 * 1000; // 15 minutes
export const REFRESH_TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Returns standard base cookie options ensuring consistent security attributes.
 * In production: sameSite='none' and secure=true to support cross-origin requests
 * between frontend (Vercel) and backend (Render).
 * In development: sameSite='lax' and secure=false for local HTTP operations.
 */
export function getBaseCookieOptions(forceProduction?: boolean): CookieOptions {
  const isProduction =
    forceProduction ?? (env.NODE_ENV === 'production' || process.env.NODE_ENV === 'production');

  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: '/',
  };
}

export function getAccessTokenCookieOptions(forceProduction?: boolean): CookieOptions {
  return {
    ...getBaseCookieOptions(forceProduction),
    maxAge: ACCESS_TOKEN_MAX_AGE_MS,
  };
}

export function getRefreshTokenCookieOptions(forceProduction?: boolean): CookieOptions {
  return {
    ...getBaseCookieOptions(forceProduction),
    maxAge: REFRESH_TOKEN_MAX_AGE_MS,
  };
}

export function getClearCookieOptions(forceProduction?: boolean): CookieOptions {
  return {
    ...getBaseCookieOptions(forceProduction),
  };
}

export function setAccessTokenCookie(
  res: Response,
  accessToken: string,
  forceProduction?: boolean
): void {
  res.cookie(COOKIE_ACCESS_NAME, accessToken, getAccessTokenCookieOptions(forceProduction));
}

export function setRefreshTokenCookie(
  res: Response,
  refreshToken: string,
  forceProduction?: boolean
): void {
  res.cookie(COOKIE_REFRESH_NAME, refreshToken, getRefreshTokenCookieOptions(forceProduction));
}

export function setAuthCookies(
  res: Response,
  accessToken: string,
  refreshToken: string,
  forceProduction?: boolean
): void {
  setAccessTokenCookie(res, accessToken, forceProduction);
  setRefreshTokenCookie(res, refreshToken, forceProduction);
}

export function clearAuthCookies(res: Response, forceProduction?: boolean): void {
  const clearOptions = getClearCookieOptions(forceProduction);
  res.clearCookie(COOKIE_ACCESS_NAME, clearOptions);
  res.clearCookie(COOKIE_REFRESH_NAME, clearOptions);
}

