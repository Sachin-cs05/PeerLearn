import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { prisma } from '../src/config/prisma.js';
import { env } from '../src/config/env.js';
import {
  generateAccessToken,
  generateRefreshToken,
} from '../src/utils/jwt.js';
import {
  COOKIE_ACCESS_NAME,
  COOKIE_REFRESH_NAME,
  getBaseCookieOptions,
  getAccessTokenCookieOptions,
  getRefreshTokenCookieOptions,
  getClearCookieOptions,
  ACCESS_TOKEN_MAX_AGE_MS,
  REFRESH_TOKEN_MAX_AGE_MS,
} from '../src/utils/cookies.js';
import { hashToken } from '../src/utils/security.js';
import {
  refreshAuthSession,
  logoutStudent,
  resetPassword,
} from '../src/services/auth.service.js';

describe('Phase 1.3: Comprehensive Production Authentication Verification', () => {
  const studentAlice = {
    id: 'student-alice-id',
    email: 'alice@university.edu',
    fullName: 'Alice Student',
    isEmailVerified: true,
    avatarUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    profile: null,
  };

  const studentBob = {
    id: 'student-bob-id',
    email: 'bob@university.edu',
    fullName: 'Bob Student',
    isEmailVerified: true,
    avatarUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    profile: null,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(prisma, '$transaction').mockImplementation(async (arg: any) => {
      if (typeof arg === 'function') {
        return arg(prisma);
      }
      return Promise.all(arg);
    });
    vi.spyOn(prisma.refreshSession, 'updateMany').mockResolvedValue({ count: 1 } as any);
  });

  // ===========================================================================
  // SECTION 1: Cookie & Browser Authentication Verification
  // ===========================================================================
  describe('1. Cookie and Browser Authentication Lifecycle', () => {
    it('1.1: Production cookie configuration enforces HttpOnly, Secure, and SameSite=None without domain attribute', () => {
      const prodOptions = getBaseCookieOptions(true);
      expect(prodOptions.httpOnly).toBe(true);
      expect(prodOptions.secure).toBe(true);
      expect(prodOptions.sameSite).toBe('none');
      expect(prodOptions.path).toBe('/');
      expect(prodOptions).not.toHaveProperty('domain');
    });

    it('1.2: Development cookie configuration enforces HttpOnly, Secure=false, and SameSite=Lax', () => {
      const devOptions = getBaseCookieOptions(false);
      expect(devOptions.httpOnly).toBe(true);
      expect(devOptions.secure).toBe(false);
      expect(devOptions.sameSite).toBe('lax');
      expect(devOptions.path).toBe('/');
    });

    it('1.3: Token lifespans adhere to production security baseline (15m access, 7d refresh)', () => {
      const accessOptions = getAccessTokenCookieOptions(true);
      const refreshOptions = getRefreshTokenCookieOptions(true);

      expect(accessOptions.maxAge).toBe(15 * 60 * 1000); // 15 minutes
      expect(refreshOptions.maxAge).toBe(7 * 24 * 60 * 60 * 1000); // 7 days
      expect(ACCESS_TOKEN_MAX_AGE_MS).toBe(900000);
      expect(REFRESH_TOKEN_MAX_AGE_MS).toBe(604800000);
    });

    it('1.4: Cookie clearing options match security attributes of issued cookies', () => {
      const clearOptionsProd = getClearCookieOptions(true);
      expect(clearOptionsProd.httpOnly).toBe(true);
      expect(clearOptionsProd.secure).toBe(true);
      expect(clearOptionsProd.sameSite).toBe('none');
      expect(clearOptionsProd.path).toBe('/');

      const clearOptionsDev = getClearCookieOptions(false);
      expect(clearOptionsDev.sameSite).toBe('lax');
      expect(clearOptionsDev.secure).toBe(false);
    });

    it('1.5: Logout endpoint clears both access and refresh cookies and revokes session', async () => {
      const token = generateRefreshToken({ userId: studentAlice.id, sessionId: 'sess-alice-logout' });
      vi.spyOn(prisma.refreshSession, 'update').mockResolvedValue({} as any);

      const res = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', [`${COOKIE_REFRESH_NAME}=${token}`])
        .set('Origin', env.WEB_ORIGIN);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify Set-Cookie headers clear both cookies
      const setCookieHeaders = res.headers['set-cookie'] as unknown as string[] | undefined;
      expect(setCookieHeaders).toBeDefined();
      const setCookies = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders!];

      const accessClear = setCookies.some(
        (c) => c.includes(`${COOKIE_ACCESS_NAME}=`) && (c.includes('Expires=') || c.includes('Max-Age=0'))
      );
      const refreshClear = setCookies.some(
        (c) => c.includes(`${COOKIE_REFRESH_NAME}=`) && (c.includes('Expires=') || c.includes('Max-Age=0'))
      );

      expect(accessClear).toBe(true);
      expect(refreshClear).toBe(true);
    });

    it('1.6: Subsequent protected API request returns 401 UNAUTHORIZED after logout', async () => {
      const res = await request(app).get('/api/auth/me');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('1.7: Silent token refresh in requireAuth transparently refreshes access cookie when access token is expired', async () => {
      const refreshToken = generateRefreshToken({ userId: studentAlice.id, sessionId: 'sess-alice-silent' });
      const hashed = hashToken(refreshToken);

      vi.spyOn(prisma.refreshSession, 'findUnique').mockResolvedValue({
        id: 'sess-alice-silent',
        userId: studentAlice.id,
        hashedToken: hashed,
        isRevoked: false,
        expiresAt: new Date(Date.now() + 100000),
        user: studentAlice,
      } as any);

      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(studentAlice as any);

      // Request with NO access token, but valid refresh cookie
      const res = await request(app)
        .get('/api/auth/me')
        .set('Cookie', [`${COOKIE_REFRESH_NAME}=${refreshToken}`]);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.id).toBe(studentAlice.id);

      // Verify a new access token cookie was set on the response
      const setCookies = res.headers['set-cookie'] as unknown as string[];
      expect(setCookies).toBeDefined();
      const hasNewAccess = setCookies.some((c) => c.includes(`${COOKIE_ACCESS_NAME}=`));
      expect(hasNewAccess).toBe(true);
    });
  });

  // ===========================================================================
  // SECTION 2: Refresh Token Security & Replay Detection
  // ===========================================================================
  describe('2. Refresh Token Security & Concurrency Invariants', () => {
    it('2.1: Normal refresh rotates token, creates new session, and revokes old session', async () => {
      const oldToken = generateRefreshToken({ userId: studentAlice.id, sessionId: 'sess-normal-old' });
      const oldHash = hashToken(oldToken);

      vi.spyOn(prisma.refreshSession, 'findUnique').mockResolvedValue({
        id: 'sess-normal-old',
        userId: studentAlice.id,
        hashedToken: oldHash,
        isRevoked: false,
        expiresAt: new Date(Date.now() + 100000),
        user: studentAlice,
      } as any);

      vi.spyOn(prisma.refreshSession, 'create').mockResolvedValue({
        id: 'sess-normal-new',
        hashedToken: 'new-hash',
      } as any);
      const updateSpy = vi.spyOn(prisma.refreshSession, 'update').mockResolvedValue({
        id: 'sess-normal-old',
        isRevoked: true,
      } as any);

      const result = await refreshAuthSession(oldToken);

      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(result.refreshToken).not.toBe(oldToken);
      expect(updateSpy).toHaveBeenCalledWith({
        where: { id: 'sess-normal-old' },
        data: { isRevoked: true },
      });
    });

    it('2.2: Expired refresh token is rejected with 401 INVALID_SESSION', async () => {
      const token = generateRefreshToken({ userId: studentAlice.id, sessionId: 'sess-expired-1' });

      vi.spyOn(prisma.refreshSession, 'findUnique').mockResolvedValue({
        id: 'sess-expired-1',
        userId: studentAlice.id,
        hashedToken: hashToken(token),
        isRevoked: false,
        expiresAt: new Date(Date.now() - 10000), // Expired!
        user: studentAlice,
      } as any);

      await expect(refreshAuthSession(token)).rejects.toThrow('Session expired');
    });

    it('2.3: Revoked refresh token is rejected with 401 REVOKED_SESSION', async () => {
      const token = generateRefreshToken({ userId: studentAlice.id, sessionId: 'sess-revoked-token' });

      vi.spyOn(prisma.refreshSession, 'findUnique').mockResolvedValue({
        id: 'sess-revoked-token',
        userId: studentAlice.id,
        hashedToken: hashToken(token),
        isRevoked: true,
        expiresAt: new Date(Date.now() + 100000),
        user: studentAlice,
      } as any);

      await expect(refreshAuthSession(token)).rejects.toThrow('Session revoked');
    });

    it('2.4: Token reuse detection: Replaying rotated token revokes all active sessions for that user', async () => {
      const reusedToken = generateRefreshToken({ userId: studentAlice.id, sessionId: 'sess-reused-target' });

      vi.spyOn(prisma.refreshSession, 'findUnique').mockResolvedValue({
        id: 'sess-reused-target',
        userId: studentAlice.id,
        hashedToken: hashToken(reusedToken),
        isRevoked: true, // already rotated previously
        expiresAt: new Date(Date.now() + 100000),
        user: studentAlice,
      } as any);

      const updateManySpy = vi.spyOn(prisma.refreshSession, 'updateMany').mockResolvedValue({ count: 2 } as any);

      await expect(refreshAuthSession(reusedToken)).rejects.toThrow('Session revoked');

      expect(updateManySpy).toHaveBeenCalledWith({
        where: { userId: studentAlice.id, isRevoked: false },
        data: { isRevoked: true },
      });
    });

    it('2.5: Replay detection does NOT revoke unrelated legitimate sessions of other users (Bob)', async () => {
      const aliceReusedToken = generateRefreshToken({ userId: studentAlice.id, sessionId: 'sess-alice-reused' });

      vi.spyOn(prisma.refreshSession, 'findUnique').mockResolvedValue({
        id: 'sess-alice-reused',
        userId: studentAlice.id,
        hashedToken: hashToken(aliceReusedToken),
        isRevoked: true,
        expiresAt: new Date(Date.now() + 100000),
        user: studentAlice,
      } as any);

      const updateManySpy = vi.spyOn(prisma.refreshSession, 'updateMany').mockResolvedValue({ count: 1 } as any);

      await expect(refreshAuthSession(aliceReusedToken)).rejects.toThrow('Session revoked');

      // Crucial security check: Bob's userId is never in the revocation filter!
      expect(updateManySpy).toHaveBeenCalledWith({
        where: { userId: studentAlice.id, isRevoked: false },
        data: { isRevoked: true },
      });
      expect(updateManySpy).not.toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: studentBob.id }),
        })
      );
    });

    it('2.6: Concurrent refresh race conditions: Only one request can rotate, concurrent request fails safely', async () => {
      const raceToken = generateRefreshToken({ userId: studentAlice.id, sessionId: 'sess-race-cond' });

      // Simulate Request 1 arriving first: sees session active
      vi.spyOn(prisma.refreshSession, 'findUnique').mockResolvedValueOnce({
        id: 'sess-race-cond',
        userId: studentAlice.id,
        hashedToken: hashToken(raceToken),
        isRevoked: false,
        expiresAt: new Date(Date.now() + 100000),
        user: studentAlice,
      } as any);

      vi.spyOn(prisma.refreshSession, 'create').mockResolvedValueOnce({ id: 'sess-race-winner' } as any);
      vi.spyOn(prisma.refreshSession, 'update').mockResolvedValueOnce({ id: 'sess-race-cond', isRevoked: true } as any);

      // Request 1 succeeds
      const result1 = await refreshAuthSession(raceToken);
      expect(result1.accessToken).toBeDefined();

      // Request 2 arrives concurrently and queries PostgreSQL: finds session now revoked
      vi.spyOn(prisma.refreshSession, 'findUnique').mockResolvedValueOnce({
        id: 'sess-race-cond',
        userId: studentAlice.id,
        hashedToken: hashToken(raceToken),
        isRevoked: true, // Updated by Request 1
        expiresAt: new Date(Date.now() + 100000),
        user: studentAlice,
      } as any);

      // Request 2 is safely rejected with REVOKED_SESSION
      await expect(refreshAuthSession(raceToken)).rejects.toThrow('Session revoked');
    });

    it('2.7: Refresh attempt after explicit logout fails with 401', async () => {
      const token = generateRefreshToken({ userId: studentAlice.id, sessionId: 'sess-loggedout' });

      // Logout called
      vi.spyOn(prisma.refreshSession, 'update').mockResolvedValue({} as any);
      await logoutStudent(token);

      // Subsequent refresh attempt finds session isRevoked: true
      vi.spyOn(prisma.refreshSession, 'findUnique').mockResolvedValue({
        id: 'sess-loggedout',
        userId: studentAlice.id,
        hashedToken: hashToken(token),
        isRevoked: true,
        expiresAt: new Date(Date.now() + 100000),
        user: studentAlice,
      } as any);

      await expect(refreshAuthSession(token)).rejects.toThrow('Session revoked');
    });
  });

  // ===========================================================================
  // SECTION 3: Multiple Device Session Validation
  // ===========================================================================
  describe('3. Multiple Device Session Validation', () => {
    it('3.1: Independent device sessions: Device A logging out leaves Device B active and functional', async () => {
      const deviceAToken = generateRefreshToken({ userId: studentAlice.id, sessionId: 'alice-laptop' });
      const deviceBToken = generateRefreshToken({ userId: studentAlice.id, sessionId: 'alice-phone' });

      const updateSpy = vi.spyOn(prisma.refreshSession, 'update').mockResolvedValue({} as any);

      // Device A logs out
      await logoutStudent(deviceAToken);

      // Only alice-laptop session was revoked
      expect(updateSpy).toHaveBeenCalledWith({
        where: { id: 'alice-laptop' },
        data: { isRevoked: true },
      });
      expect(updateSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'alice-phone' } })
      );

      // Device B proceeds to rotate its token normally
      vi.spyOn(prisma.refreshSession, 'findUnique').mockResolvedValue({
        id: 'alice-phone',
        userId: studentAlice.id,
        hashedToken: hashToken(deviceBToken),
        isRevoked: false,
        expiresAt: new Date(Date.now() + 100000),
        user: studentAlice,
      } as any);

      vi.spyOn(prisma.refreshSession, 'create').mockResolvedValue({ id: 'alice-phone-v2' } as any);
      vi.spyOn(prisma.refreshSession, 'update').mockResolvedValue({ id: 'alice-phone', isRevoked: true } as any);

      const deviceBRefresh = await refreshAuthSession(deviceBToken);
      expect(deviceBRefresh.accessToken).toBeDefined();
    });

    it('3.2: Password reset revokes all device sessions for the user', async () => {
      const resetRawToken = 'secret-reset-token-pass';
      const tokenHash = hashToken(resetRawToken);

      vi.spyOn(prisma.passwordResetToken, 'findUnique').mockResolvedValue({
        id: 'reset-id-100',
        userId: studentAlice.id,
        tokenHash,
        expiresAt: new Date(Date.now() + 60000),
        usedAt: null,
        user: studentAlice,
      } as any);

      vi.spyOn(prisma.user, 'update').mockResolvedValue(studentAlice as any);
      vi.spyOn(prisma.passwordResetToken, 'update').mockResolvedValue({} as any);
      const updateManySpy = vi.spyOn(prisma.refreshSession, 'updateMany').mockResolvedValue({ count: 4 } as any);

      await resetPassword(resetRawToken, 'NewAlicePassword2026!');

      // Asserts ALL active sessions across all devices were revoked
      expect(updateManySpy).toHaveBeenCalledWith({
        where: { userId: studentAlice.id, isRevoked: false },
        data: { isRevoked: true },
      });
    });
  });

  // ===========================================================================
  // SECTION 4: Cross-Site Request Forgery (CSRF) Verification
  // ===========================================================================
  describe('4. Cross-Site Request Forgery (CSRF) Invariants', () => {
    it('4.1: Allows mutating cookie-authenticated request from trusted frontend Origin (env.WEB_ORIGIN)', async () => {
      const token = generateAccessToken({ userId: studentAlice.id, email: studentAlice.email });
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(studentAlice as any);
      vi.spyOn(prisma.refreshSession, 'update').mockResolvedValue({} as any);

      const res = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${token}`])
        .set('Origin', env.WEB_ORIGIN);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('4.2: Blocks mutating cookie-authenticated request from untrusted Origin with 403 CSRF_FORBIDDEN', async () => {
      const token = generateAccessToken({ userId: studentAlice.id, email: studentAlice.email });

      const res = await request(app)
        .post('/api/sessions')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${token}`])
        .set('Origin', 'https://malicious-attacker-hacker.com')
        .send({ title: 'Exploit Session' });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('CSRF_FORBIDDEN');
    });

    it('4.3: Allows mutating cookie-authenticated request when Origin is missing but valid Referer matches WEB_ORIGIN', async () => {
      const token = generateAccessToken({ userId: studentAlice.id, email: studentAlice.email });
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(studentAlice as any);
      vi.spyOn(prisma.refreshSession, 'update').mockResolvedValue({} as any);

      const res = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${token}`])
        .set('Referer', `${env.WEB_ORIGIN}/dashboard/workspace`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('4.4: Blocks mutating cookie-authenticated request when Origin is missing but Referer is untrusted', async () => {
      const token = generateAccessToken({ userId: studentAlice.id, email: studentAlice.email });

      const res = await request(app)
        .post('/api/sessions')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${token}`])
        .set('Referer', 'https://phishing-site.org/fake-page')
        .send({ title: 'Unauthorized Session' });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('CSRF_FORBIDDEN');
    });

    it('4.5: Blocks mutating cookie-authenticated request when Referer is malformed URL', async () => {
      const token = generateAccessToken({ userId: studentAlice.id, email: studentAlice.email });

      const res = await request(app)
        .post('/api/sessions')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${token}`])
        .set('Referer', 'not-a-valid-http-url')
        .send({ title: 'Malformed Referer Request' });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('CSRF_FORBIDDEN');
    });

    it('4.6: Blocks mutating cookie-authenticated request in production mode when both Origin and Referer are missing', async () => {
      const origEnv = env.NODE_ENV;
      try {
        (env as any).NODE_ENV = 'production';
        const token = generateAccessToken({ userId: studentAlice.id, email: studentAlice.email });

        const res = await request(app)
          .post('/api/sessions')
          .set('Cookie', [`${COOKIE_ACCESS_NAME}=${token}`])
          .send({ title: 'Blind CSRF Request' });

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
        expect(res.body.error.code).toBe('CSRF_FORBIDDEN');
      } finally {
        (env as any).NODE_ENV = origEnv;
      }
    });

    it('4.7: Allows safe read-only GET requests even with external/untrusted Origin', async () => {
      const token = generateAccessToken({ userId: studentAlice.id, email: studentAlice.email });
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(studentAlice as any);

      const res = await request(app)
        .get('/api/auth/me')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${token}`])
        .set('Origin', 'https://external-search-engine.com');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('4.8: Allows Authorization Bearer header request without cookies (mobile / cURL API client exemption)', async () => {
      const token = generateAccessToken({ userId: studentAlice.id, email: studentAlice.email });
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(studentAlice as any);
      vi.spyOn(prisma.refreshSession, 'update').mockResolvedValue({} as any);

      const res = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${token}`)
        .set('Origin', 'https://mobile-app-client.org');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('4.9: CRITICAL: Bearer exemption cannot be used to bypass cookie-based CSRF checks through auth fallback', async () => {
      // Scenario: Attacker creates a cross-origin form/fetch with credentials: 'include' (browser attaches cookies)
      // AND adds a dummy Authorization header attempting to trigger the Bearer exemption.
      // Because cookies are attached by the browser, hasAuthCookie is true.
      // csrfProtection must still execute and reject the untrusted origin!
      const validCookieToken = generateAccessToken({ userId: studentAlice.id, email: studentAlice.email });

      const res = await request(app)
        .post('/api/sessions')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${validCookieToken}`])
        .set('Authorization', 'Bearer attacker-fake-token')
        .set('Origin', 'https://evil-attacker.com')
        .send({ title: 'Bypass Attempt' });

      // Must be rejected with 403 CSRF_FORBIDDEN, NOT bypassed
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('CSRF_FORBIDDEN');
    });
  });

  // ===========================================================================
  // SECTION 5: Cross-Origin Resource Sharing (CORS) Verification
  // ===========================================================================
  describe('5. Cross-Origin Resource Sharing (CORS) Verification', () => {
    it('5.1: Approved Vercel production frontend origin receives CORS allow headers and credentials', async () => {
      const res = await request(app)
        .get('/api/health')
        .set('Origin', env.WEB_ORIGIN);

      expect(res.headers['access-control-allow-origin']).toBe(env.WEB_ORIGIN);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('5.2: Approved local development origin receives CORS allow headers and credentials in dev mode', async () => {
      const origEnv = env.NODE_ENV;
      try {
        (env as any).NODE_ENV = 'development';
        const res = await request(app)
          .get('/api/health')
          .set('Origin', 'http://localhost:5173');

        expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
        expect(res.headers['access-control-allow-credentials']).toBe('true');
      } finally {
        (env as any).NODE_ENV = origEnv;
      }
    });

    it('5.3: Unapproved external origin does NOT receive Access-Control-Allow-Origin header (browser blocks)', async () => {
      const res = await request(app)
        .get('/api/health')
        .set('Origin', 'https://unauthorized-evil-domain.com');

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('5.4: Preflight OPTIONS request from approved origin receives 204 No Content with allowed methods', async () => {
      const res = await request(app)
        .options('/api/auth/login')
        .set('Origin', env.WEB_ORIGIN)
        .set('Access-Control-Request-Method', 'POST');

      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(env.WEB_ORIGIN);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(res.headers['access-control-allow-methods']).toContain('POST');
    });

    it('5.5: Preflight OPTIONS request from unapproved origin is denied CORS headers', async () => {
      const res = await request(app)
        .options('/api/auth/login')
        .set('Origin', 'https://unauthorized-intruder.com')
        .set('Access-Control-Request-Method', 'POST');

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});

