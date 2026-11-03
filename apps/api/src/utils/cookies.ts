import type { Response } from 'express';
import { env } from '../config/env.js';

export const COOKIE_ACCESS_NAME = 'peerlume_access_token';
export const COOKIE_REFRESH_NAME = 'peerlume_refresh_token';

const isProduction = env.NODE_ENV === 'production';

export function setAuthCookies(
  res: Response,
  accessToken: string,
  refreshToken: string
): void {
  // Access Token Cookie (15 minutes)
  res.cookie(COOKIE_ACCESS_NAME, accessToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: '/',
    maxAge: 15 * 60 * 1000,
  });

  // Refresh Token Cookie (7 days)
  res.cookie(COOKIE_REFRESH_NAME, refreshToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(COOKIE_ACCESS_NAME, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
  });

  res.clearCookie(COOKIE_REFRESH_NAME, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
  });
}
