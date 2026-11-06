import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/config/prisma.js';
import {
  COOKIE_ACCESS_NAME,
  COOKIE_REFRESH_NAME,
  getBaseCookieOptions,
  getAccessTokenCookieOptions,
  getRefreshTokenCookieOptions,
  getClearCookieOptions,
  clearAuthCookies,
  ACCESS_TOKEN_MAX_AGE_MS,
  REFRESH_TOKEN_MAX_AGE_MS,
} from '../src/utils/cookies.js';
import { generateAccessToken, generateRefreshToken } from '../src/utils/jwt.js';
import { hashToken, hashPassword } from '../src/utils/security.js';

describe('Phase 1.1: Authentication Cookie Security & Lifecycle Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  // Scenario 1: Production cookie configuration
  describe('1. Production Cookie Configuration', () => {
    it('generates SameSite=None and Secure=true options when in production mode', () => {
      const prodOptions = getBaseCookieOptions(true);
      expect(prodOptions.httpOnly).toBe(true);
      expect(prodOptions.secure).toBe(true);
      expect(prodOptions.sameSite).toBe('none');
      expect(prodOptions.path).toBe('/');
      expect(prodOptions).not.toHaveProperty('domain'); // No hardcoded domain attribute
    });

    it('sets correct maxAge on production access and refresh token options', () => {
      const accessOptions = getAccessTokenCookieOptions(true);
      const refreshOptions = getRefreshTokenCookieOptions(true);

      expect(accessOptions.sameSite).toBe('none');
      expect(accessOptions.secure).toBe(true);
      expect(accessOptions.maxAge).toBe(ACCESS_TOKEN_MAX_AGE_MS);

      expect(refreshOptions.sameSite).toBe('none');
      expect(refreshOptions.secure).toBe(true);
      expect(refreshOptions.maxAge).toBe(REFRESH_TOKEN_MAX_AGE_MS);
    });
  });

  // Scenario 2: Development cookie configuration
  describe('2. Development Cookie Configuration', () => {
    it('generates SameSite=Lax and Secure=false options when in development mode', () => {
      const devOptions = getBaseCookieOptions(false);
      expect(devOptions.httpOnly).toBe(true);
      expect(devOptions.secure).toBe(false);
      expect(devOptions.sameSite).toBe('lax');
      expect(devOptions.path).toBe('/');
    });

    it('sets correct maxAge on development access and refresh token options', () => {
      const accessOptions = getAccessTokenCookieOptions(false);
      const refreshOptions = getRefreshTokenCookieOptions(false);

      expect(accessOptions.sameSite).toBe('lax');
      expect(accessOptions.secure).toBe(false);
      expect(accessOptions.maxAge).toBe(ACCESS_TOKEN_MAX_AGE_MS);

      expect(refreshOptions.sameSite).toBe('lax');
      expect(refreshOptions.secure).toBe(false);
      expect(refreshOptions.maxAge).toBe(REFRESH_TOKEN_MAX_AGE_MS);
    });
  });

  // Scenarios 3 & 4: Access and Refresh cookie clearing
  describe('3 & 4. Cookie Clearing Invariants', () => {
    it('clear options match base cookie security attributes exactly', () => {
      const clearOptionsProd = getClearCookieOptions(true);
      const baseOptionsProd = getBaseCookieOptions(true);

      expect(clearOptionsProd.httpOnly).toBe(baseOptionsProd.httpOnly);
      expect(clearOptionsProd.secure).toBe(baseOptionsProd.secure);
      expect(clearOptionsProd.sameSite).toBe(baseOptionsProd.sameSite);
      expect(clearOptionsProd.path).toBe(baseOptionsProd.path);

      const clearOptionsDev = getClearCookieOptions(false);
      const baseOptionsDev = getBaseCookieOptions(false);
      expect(clearOptionsDev.sameSite).toBe('lax');
      expect(clearOptionsDev.secure).toBe(false);
    });

    it('clearAuthCookies calls res.clearCookie for both access and refresh cookies with matching options', () => {
      const clearedCookies: { name: string; options: any }[] = [];
      const mockRes: any = {
        clearCookie: (name: string, options: any) => {
          clearedCookies.push({ name, options });
        },
      };

      clearAuthCookies(mockRes, true); // in production mode

      expect(clearedCookies).toHaveLength(2);
      expect(clearedCookies[0].name).toBe(COOKIE_ACCESS_NAME);
      expect(clearedCookies[0].options.sameSite).toBe('none');
      expect(clearedCookies[0].options.secure).toBe(true);
      expect(clearedCookies[0].options.path).toBe('/');

      expect(clearedCookies[1].name).toBe(COOKIE_REFRESH_NAME);
      expect(clearedCookies[1].options.sameSite).toBe('none');
      expect(clearedCookies[1].options.secure).toBe(true);
      expect(clearedCookies[1].options.path).toBe('/');
    });
  });

  // Scenario 5: Successful token refresh (both explicit POST /api/auth/refresh and silent middleware)
  describe('5. Successful Token Refresh', () => {
    it('POST /api/auth/refresh sets fresh access and refresh cookies with consistent security options', async () => {
      const mockUser = {
        id: 'user-refresh-1',
        email: 'refresh.student@peerlearn.edu',
        fullName: 'Refresh Student',
        isEmailVerified: true,
        avatarUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        profile: null,
      };

      const rawRefreshToken = generateRefreshToken({
        userId: mockUser.id,
        sessionId: 'session-refresh-1',
      });
      const hashedOldToken = hashToken(rawRefreshToken);

      vi.spyOn(prisma.refreshSession, 'findUnique').mockResolvedValue({
        id: 'session-refresh-1',
        userId: mockUser.id,
        hashedToken: hashedOldToken,
        isRevoked: false,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 1 day in future
        user: mockUser,
      } as any);

      vi.spyOn(prisma, '$transaction').mockResolvedValue([
        { id: 'new-session-id', hashedToken: 'new-hash' },
        { id: 'session-refresh-1', isRevoked: true },
      ] as any);

      const res = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', [`${COOKIE_REFRESH_NAME}=${rawRefreshToken}`]);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('Session refreshed');

      // Verify Set-Cookie headers contain both tokens
      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      const cookieHeaderStr = Array.isArray(cookies) ? cookies.join('; ') : cookies;
      expect(cookieHeaderStr).toContain(COOKIE_ACCESS_NAME);
      expect(cookieHeaderStr).toContain(COOKIE_REFRESH_NAME);
      expect(cookieHeaderStr).toContain('HttpOnly');
      expect(cookieHeaderStr).toContain('Path=/');
    });

    it('silent token rotation in requireAuth middleware refreshes access cookie using centralized options', async () => {
      const mockUser = {
        id: 'user-silent-1',
        email: 'silent.student@peerlearn.edu',
        fullName: 'Silent Student',
        isEmailVerified: true,
        avatarUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        profile: null,
      };

      const rawRefreshToken = generateRefreshToken({
        userId: mockUser.id,
        sessionId: 'session-silent-1',
      });
      const hashedToken = hashToken(rawRefreshToken);

      vi.spyOn(prisma.refreshSession, 'findUnique').mockResolvedValue({
        id: 'session-silent-1',
        userId: mockUser.id,
        hashedToken: hashedToken,
        isRevoked: false,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        user: mockUser,
      } as any);

      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(mockUser as any);

      // Make a request to protected endpoint without access token, but WITH valid refresh token cookie
      const res = await request(app)
        .get('/api/auth/me')
        .set('Cookie', [`${COOKIE_REFRESH_NAME}=${rawRefreshToken}`]);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.id).toBe(mockUser.id);

      // Verify refreshed access cookie was sent in response
      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      const cookieHeaderStr = Array.isArray(cookies) ? cookies.join('; ') : cookies;
      expect(cookieHeaderStr).toContain(COOKIE_ACCESS_NAME);
      expect(cookieHeaderStr).toContain('HttpOnly');
      expect(cookieHeaderStr).toContain('Path=/');
    });
  });

  // Scenario 6: Expired refresh token
  describe('6. Expired Refresh Token', () => {
    it('POST /api/auth/refresh rejects expired refresh session with 401', async () => {
      const rawRefreshToken = generateRefreshToken({
        userId: 'user-expired-1',
        sessionId: 'session-expired-1',
      });
      const hashedToken = hashToken(rawRefreshToken);

      vi.spyOn(prisma.refreshSession, 'findUnique').mockResolvedValue({
        id: 'session-expired-1',
        userId: 'user-expired-1',
        hashedToken: hashedToken,
        isRevoked: false,
        expiresAt: new Date(Date.now() - 1000 * 60), // Expired 1 minute ago!
        user: { id: 'user-expired-1', email: 'expired@peerlearn.edu' },
      } as any);

      const res = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', [`${COOKIE_REFRESH_NAME}=${rawRefreshToken}`]);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_SESSION');
    });

    it('requireAuth rejects request when refresh token is expired', async () => {
      const rawRefreshToken = generateRefreshToken({
        userId: 'user-expired-2',
        sessionId: 'session-expired-2',
      });
      const hashedToken = hashToken(rawRefreshToken);

      vi.spyOn(prisma.refreshSession, 'findUnique').mockResolvedValue({
        id: 'session-expired-2',
        userId: 'user-expired-2',
        hashedToken: hashedToken,
        isRevoked: false,
        expiresAt: new Date(Date.now() - 1000 * 60), // Expired!
        user: { id: 'user-expired-2', email: 'expired2@peerlearn.edu' },
      } as any);

      const res = await request(app)
        .get('/api/auth/me')
        .set('Cookie', [`${COOKIE_REFRESH_NAME}=${rawRefreshToken}`]);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });
  });

  // Scenario 7: Logout followed by an unauthenticated request
  describe('7. Logout Followed by Unauthenticated Request', () => {
    it('POST /api/auth/logout sets expired clear-cookie headers and subsequent request fails with 401', async () => {
      vi.spyOn(prisma.refreshSession, 'update').mockResolvedValue({} as any);

      // 1. Perform logout
      const logoutRes = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=some-token`, `${COOKIE_REFRESH_NAME}=some-refresh`]);

      expect(logoutRes.status).toBe(200);
      expect(logoutRes.body.success).toBe(true);

      const cookies = logoutRes.headers['set-cookie'];
      expect(cookies).toBeDefined();
      const cookieStr = Array.isArray(cookies) ? cookies.join('; ') : cookies;
      // Express clearCookie sends Expires=Thu, 01 Jan 1970
      expect(cookieStr).toContain('1970');
      expect(cookieStr).toContain(COOKIE_ACCESS_NAME);
      expect(cookieStr).toContain(COOKIE_REFRESH_NAME);

      // 2. Subsequent request without cookies or with cleared cookies returns 401
      const meRes = await request(app).get('/api/auth/me');
      expect(meRes.status).toBe(401);
      expect(meRes.body.success).toBe(false);
      expect(meRes.body.error.code).toBe('UNAUTHORIZED');
    });
  });

  // Scenario 8: Cookie configuration consistency across all authentication paths
  describe('8. Cookie Configuration Consistency', () => {
    it('POST /api/auth/login sets cookies using identical helper options as /api/auth/refresh', async () => {
      const mockHash = await hashPassword('StudentPassword123!');
      const mockUser = {
        id: 'user-consistent-1',
        email: 'consistent@peerlearn.edu',
        passwordHash: mockHash,
        fullName: 'Consistent Student',
        isEmailVerified: true,
        avatarUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(mockUser as any);
      vi.spyOn(prisma.refreshSession, 'create').mockResolvedValue({
        id: 'session-login-1',
        userId: mockUser.id,
      } as any);

      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({
          email: mockUser.email,
          password: 'StudentPassword123!',
        });

      expect(loginRes.status).toBe(200);
      const cookies = loginRes.headers['set-cookie'];
      expect(cookies).toBeDefined();

      const cookieStr = Array.isArray(cookies) ? cookies.join('; ') : cookies;
      expect(cookieStr).toContain(COOKIE_ACCESS_NAME);
      expect(cookieStr).toContain(COOKIE_REFRESH_NAME);
      expect(cookieStr).toContain('HttpOnly');
      expect(cookieStr).toContain('Path=/');
    });
  });
});
