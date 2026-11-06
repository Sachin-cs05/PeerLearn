import type { Request, Response, NextFunction } from 'express';
import { HTTP_STATUS } from '@peerlume/shared';
import { sendError } from '../utils/apiResponse.js';
import { verifyAccessToken, verifyRefreshToken, generateAccessToken } from '../utils/jwt.js';
import { COOKIE_ACCESS_NAME, COOKIE_REFRESH_NAME, setAccessTokenCookie } from '../utils/cookies.js';
import { prisma } from '../config/prisma.js';
import { hashToken } from '../utils/security.js';

export interface AuthenticatedUser {
  id: string;
  email: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // 1. Try reading Access Token from Cookie or Bearer header
    let accessToken = req.cookies?.[COOKIE_ACCESS_NAME];
    const authHeader = req.headers.authorization;
    if (!accessToken && authHeader?.startsWith('Bearer ')) {
      accessToken = authHeader.substring(7);
    }

    if (accessToken) {
      const payload = verifyAccessToken(accessToken);
      if (payload) {
        req.user = {
          id: payload.userId,
          email: payload.email,
        };
        next();
        return;
      }
    }

    // 2. Access token is missing or expired; try using Refresh Token from Cookie
    const refreshToken = req.cookies?.[COOKIE_REFRESH_NAME];
    if (refreshToken) {
      const refreshPayload = verifyRefreshToken(refreshToken);
      if (refreshPayload) {
        const hashed = hashToken(refreshToken);
        const session = await prisma.refreshSession.findUnique({
          where: { hashedToken: hashed },
          include: { user: true },
        });

        if (session && !session.isRevoked && session.expiresAt > new Date()) {
          // Refresh session is valid! Issue new access token
          const newAccessToken = generateAccessToken({
            userId: session.user.id,
            email: session.user.email,
          });

          // Refresh the access cookie using centralized options
          setAccessTokenCookie(res, newAccessToken);

          req.user = {
            id: session.user.id,
            email: session.user.email,
          };
          next();
          return;
        }
      }
    }

    sendError(
      res,
      HTTP_STATUS.UNAUTHORIZED,
      'UNAUTHORIZED',
      'Authentication required. Please log in to continue.'
    );
  } catch (error) {
    next(error);
  }
}

export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const accessToken = req.cookies?.[COOKIE_ACCESS_NAME] || req.headers.authorization?.substring(7);
    if (accessToken) {
      const payload = verifyAccessToken(accessToken);
      if (payload) {
        req.user = { id: payload.userId, email: payload.email };
      }
    }
    next();
  } catch {
    next();
  }
}
