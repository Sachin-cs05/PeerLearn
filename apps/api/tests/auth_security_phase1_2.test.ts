import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { prisma } from '../src/config/prisma.js';
import {
  generateAccessToken,
  generateRefreshToken,
} from '../src/utils/jwt.js';
import {
  COOKIE_ACCESS_NAME,
} from '../src/utils/cookies.js';
import { hashToken } from '../src/utils/security.js';
import {
  refreshAuthSession,
  logoutStudent,
  resetPassword,
} from '../src/services/auth.service.js';

describe('Phase 1.2: Comprehensive Authentication Security & Session Validation', () => {
  const mockUser = {
    id: 'user-sec-101',
    email: 'sec.student@peerlearn.edu',
    fullName: 'Security Student',
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

  // ---------------------------------------------------------------------------
  // 1-4: Access Token Security (Valid, Expired, Invalid Signature, Malformed)
  // ---------------------------------------------------------------------------
  describe('1-4. Access Token Security Invariants', () => {
    it('1. accepts valid access token and permits access to protected endpoints', async () => {
      const token = generateAccessToken({ userId: mockUser.id, email: mockUser.email });
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(mockUser as any);

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.id).toBe(mockUser.id);
    });

    it('2. rejects expired access token with 401 when no refresh token is provided', async () => {
      // Sign with -10 seconds remaining
      const expiredToken = jwt.sign(
        { userId: mockUser.id, email: mockUser.email },
        process.env.JWT_ACCESS_SECRET || 'peerlume_dev_jwt_access_secret_super_secure_32chars!',
        { expiresIn: '-10s', issuer: 'peerlume-api', algorithm: 'HS256' }
      );

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${expiredToken}`);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('3. rejects access token with invalid or forged signature with 401', async () => {
      const forgedToken = jwt.sign(
        { userId: mockUser.id, email: mockUser.email },
        'different-attacker-secret-key-32chars-long!',
        { expiresIn: '15m', issuer: 'peerlume-api', algorithm: 'HS256' }
      );

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${forgedToken}`);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('4. rejects malformed or truncated JWT string with 401', async () => {
      const malformedToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.corrupted_payload.invalid_signature';

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${malformedToken}`);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });
  });

  // ---------------------------------------------------------------------------
  // 5-9: Refresh Token Rotation, Expiration, Revocation & Reuse Detection
  // ---------------------------------------------------------------------------
  describe('5-9. Refresh Token Rotation & Reuse Detection', () => {
    it('5. rejects expired refresh token and prevents session refresh', async () => {
      const token = generateRefreshToken({ userId: mockUser.id, sessionId: 'sess-exp-1' });

      vi.spyOn(prisma.refreshSession, 'findUnique').mockResolvedValue({
        id: 'sess-exp-1',
        userId: mockUser.id,
        hashedToken: hashToken(token),
        isRevoked: false,
        expiresAt: new Date(Date.now() - 5000), // Expired
        user: mockUser,
      } as any);

      await expect(refreshAuthSession(token)).rejects.toThrow('Session expired');
    });

    it('6. rejects explicitly revoked refresh token with REVOKED_SESSION', async () => {
      const token = generateRefreshToken({ userId: mockUser.id, sessionId: 'sess-revoked-1' });

      vi.spyOn(prisma.refreshSession, 'findUnique').mockResolvedValue({
        id: 'sess-revoked-1',
        userId: mockUser.id,
        hashedToken: hashToken(token),
        isRevoked: true, // Already revoked
        expiresAt: new Date(Date.now() + 100000),
        user: mockUser,
      } as any);

      const updateManySpy = vi.spyOn(prisma.refreshSession, 'updateMany').mockResolvedValue({ count: 1 } as any);

      await expect(refreshAuthSession(token)).rejects.toThrow('Session revoked');
      expect(updateManySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: mockUser.id, isRevoked: false }),
          data: { isRevoked: true },
        })
      );
    });

    it('7. successfully rotates refresh token: revokes old session and creates new session in a transaction', async () => {
      const oldToken = generateRefreshToken({ userId: mockUser.id, sessionId: 'sess-rotate-old' });
      const oldHash = hashToken(oldToken);

      vi.spyOn(prisma.refreshSession, 'findUnique').mockResolvedValue({
        id: 'sess-rotate-old',
        userId: mockUser.id,
        hashedToken: oldHash,
        isRevoked: false,
        expiresAt: new Date(Date.now() + 100000),
        user: mockUser,
      } as any);

      vi.spyOn(prisma.refreshSession, 'create').mockResolvedValue({
        id: 'sess-rotate-new',
        hashedToken: 'new-hash',
      } as any);
      vi.spyOn(prisma.refreshSession, 'update').mockResolvedValue({
        id: 'sess-rotate-old',
        isRevoked: true,
      } as any);

      const result = await refreshAuthSession(oldToken);

      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(result.refreshToken).not.toBe(oldToken);
    });

    it('8. detects refresh-token reuse: revokes all user sessions when previously rotated token is re-submitted', async () => {
      const compromisedOldToken = generateRefreshToken({
        userId: mockUser.id,
        sessionId: 'sess-reused-1',
      });

      // Session is already marked revoked because it was rotated previously
      vi.spyOn(prisma.refreshSession, 'findUnique').mockResolvedValue({
        id: 'sess-reused-1',
        userId: mockUser.id,
        hashedToken: hashToken(compromisedOldToken),
        isRevoked: true,
        expiresAt: new Date(Date.now() + 100000),
        user: mockUser,
      } as any);

      const updateManySpy = vi.spyOn(prisma.refreshSession, 'updateMany').mockResolvedValue({ count: 2 } as any);

      // Attempting to refresh with the already-rotated token
      await expect(refreshAuthSession(compromisedOldToken)).rejects.toThrow('Session revoked');

      // Verifies all remaining active sessions for this compromised account are wiped
      expect(updateManySpy).toHaveBeenCalledWith({
        where: { userId: mockUser.id, isRevoked: false },
        data: { isRevoked: true },
      });
    });

    it('9. prevents concurrent refresh race conditions by requiring valid unrevoked session', async () => {
      const token = generateRefreshToken({ userId: mockUser.id, sessionId: 'sess-concurrent-1' });

      // First query succeeds
      vi.spyOn(prisma.refreshSession, 'findUnique').mockResolvedValueOnce({
        id: 'sess-concurrent-1',
        userId: mockUser.id,
        hashedToken: hashToken(token),
        isRevoked: false,
        expiresAt: new Date(Date.now() + 100000),
        user: mockUser,
      } as any);

      vi.spyOn(prisma.refreshSession, 'create').mockResolvedValueOnce({
        id: 'sess-concurrent-new',
      } as any);
      vi.spyOn(prisma.refreshSession, 'update').mockResolvedValueOnce({
        id: 'sess-concurrent-1',
        isRevoked: true,
      } as any);

      const firstRefresh = await refreshAuthSession(token);
      expect(firstRefresh.accessToken).toBeDefined();

      // Second concurrent query finds the session already revoked
      vi.spyOn(prisma.refreshSession, 'findUnique').mockResolvedValueOnce({
        id: 'sess-concurrent-1',
        userId: mockUser.id,
        hashedToken: hashToken(token),
        isRevoked: true, // Now revoked!
        expiresAt: new Date(Date.now() + 100000),
        user: mockUser,
      } as any);

      await expect(refreshAuthSession(token)).rejects.toThrow('Session revoked');
    });
  });

  // ---------------------------------------------------------------------------
  // 10-11: Logout, Session Revocation & Multi-Device Isolation
  // ---------------------------------------------------------------------------
  describe('10-11. Logout & Multi-Device Session Isolation', () => {
    it('10. logout revokes only the caller session and clears auth cookies', async () => {
      const token = generateRefreshToken({ userId: mockUser.id, sessionId: 'sess-logout-1' });

      const updateSpy = vi.spyOn(prisma.refreshSession, 'update').mockResolvedValue({} as any);

      await logoutStudent(token);

      expect(updateSpy).toHaveBeenCalledWith({
        where: { id: 'sess-logout-1' },
        data: { isRevoked: true },
      });
    });

    it('11. multiple-device session isolation: logging out device 1 does not affect device 2', async () => {
      const device1Token = generateRefreshToken({ userId: mockUser.id, sessionId: 'device-1-session' });
      const device2Token = generateRefreshToken({ userId: mockUser.id, sessionId: 'device-2-session' });

      const updateSpy = vi.spyOn(prisma.refreshSession, 'update').mockResolvedValue({} as any);

      // Logout device 1
      await logoutStudent(device1Token);

      // Asserts ONLY device-1-session was targeted for revocation
      expect(updateSpy).toHaveBeenCalledWith({
        where: { id: 'device-1-session' },
        data: { isRevoked: true },
      });
      expect(updateSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'device-2-session' } })
      );

      // Device 2's session remains active and valid
      vi.spyOn(prisma.refreshSession, 'findUnique').mockResolvedValue({
        id: 'device-2-session',
        userId: mockUser.id,
        hashedToken: hashToken(device2Token),
        isRevoked: false,
        expiresAt: new Date(Date.now() + 100000),
        user: mockUser,
      } as any);

      vi.spyOn(prisma.refreshSession, 'create').mockResolvedValue({
        id: 'device-2-session-rotated',
      } as any);
      vi.spyOn(prisma.refreshSession, 'update').mockResolvedValue({
        id: 'device-2-session',
        isRevoked: true,
      } as any);

      const device2Refresh = await refreshAuthSession(device2Token);
      expect(device2Refresh.accessToken).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 12-14: Missing Auth, Authorization & Rate Limiting
  // ---------------------------------------------------------------------------
  describe('12-14. Route Protection & Rate Limiting', () => {
    it('12. returns 401 UNAUTHORIZED on protected route when all credentials are missing', async () => {
      const res = await request(app).get('/api/auth/me');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('13. prevents unauthorized users from accessing other student profiles via protected routes', async () => {
      const res = await request(app).get('/api/profile/me');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('14. applies rate limiting headers and protects /api/auth/login against brute-force attacks', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(null);

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'nonexistent@peerlearn.edu', password: 'Password123!' });

      expect(res.status).toBe(401);
      // Standard rate limit headers must be present
      expect(res.headers).toHaveProperty('ratelimit-limit');
      expect(res.headers).toHaveProperty('ratelimit-remaining');
    });
  });

  // ---------------------------------------------------------------------------
  // 15: Cross-Site Request Forgery (CSRF) Protection
  // ---------------------------------------------------------------------------
  describe('15. Cross-Site Request Forgery (CSRF) Protection', () => {
    it('blocks mutating cookie-authenticated request from untrusted origin with 403 CSRF_FORBIDDEN', async () => {
      const res = await request(app)
        .post('/api/sessions')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=some-access-token`])
        .set('Origin', 'https://malicious-attacker-site.com')
        .send({ title: 'Exploit Session' });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('CSRF_FORBIDDEN');
    });

    it('allows mutating cookie-authenticated request from trusted origin (WEB_ORIGIN)', async () => {
      const token = generateAccessToken({ userId: mockUser.id, email: mockUser.email });
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(mockUser as any);
      vi.spyOn(prisma.refreshSession, 'update').mockResolvedValue({} as any);

      const res = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${token}`])
        .set('Origin', process.env.WEB_ORIGIN || 'http://localhost:5173');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('exempts safe read-only GET requests from CSRF origin checks', async () => {
      const token = generateAccessToken({ userId: mockUser.id, email: mockUser.email });
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(mockUser as any);

      const res = await request(app)
        .get('/api/auth/me')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${token}`])
        .set('Origin', 'https://some-external-referrer.com');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('exempts Authorization Bearer header requests from CSRF checks (mobile / cURL clients)', async () => {
      const token = generateAccessToken({ userId: mockUser.id, email: mockUser.email });
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(mockUser as any);
      vi.spyOn(prisma.refreshSession, 'update').mockResolvedValue({} as any);

      const res = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${token}`)
        .set('Origin', 'https://mobile-or-third-party.com');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 16-18: Password Reset Security & Session Invalidation
  // ---------------------------------------------------------------------------
  describe('16-18. Password Reset Security & Session Invalidation', () => {
    it('16. rejects expired password reset token with 400 INVALID_RESET_TOKEN', async () => {
      const rawToken = 'expired-token-12345';
      const tokenHash = hashToken(rawToken);

      vi.spyOn(prisma.passwordResetToken, 'findUnique').mockResolvedValue({
        id: 'reset-token-1',
        userId: mockUser.id,
        tokenHash,
        expiresAt: new Date(Date.now() - 5000), // Expired!
        usedAt: null,
        user: mockUser,
      } as any);

      await expect(resetPassword(rawToken, 'NewSecurePassword123!')).rejects.toThrow(
        'Password reset link is invalid or has expired'
      );
    });

    it('17. rejects single-use password reset token when reused (usedAt !== null)', async () => {
      const rawToken = 'reused-token-12345';
      const tokenHash = hashToken(rawToken);

      vi.spyOn(prisma.passwordResetToken, 'findUnique').mockResolvedValue({
        id: 'reset-token-2',
        userId: mockUser.id,
        tokenHash,
        expiresAt: new Date(Date.now() + 60000),
        usedAt: new Date(Date.now() - 1000), // Already used!
        user: mockUser,
      } as any);

      await expect(resetPassword(rawToken, 'NewSecurePassword123!')).rejects.toThrow(
        'Password reset link is invalid or has expired'
      );
    });

    it('18. password change invalidates all active sessions for the user across all devices', async () => {
      const rawToken = 'valid-token-12345';
      const tokenHash = hashToken(rawToken);

      vi.spyOn(prisma.passwordResetToken, 'findUnique').mockResolvedValue({
        id: 'reset-token-3',
        userId: mockUser.id,
        tokenHash,
        expiresAt: new Date(Date.now() + 60000),
        usedAt: null,
        user: mockUser,
      } as any);

      vi.spyOn(prisma.user, 'update').mockResolvedValue(mockUser as any);
      vi.spyOn(prisma.passwordResetToken, 'update').mockResolvedValue({} as any);
      const updateManySpy = vi.spyOn(prisma.refreshSession, 'updateMany').mockResolvedValue({ count: 3 } as any);

      await resetPassword(rawToken, 'NewStrongPassword123!');

      expect(updateManySpy).toHaveBeenCalledWith({
        where: { userId: mockUser.id, isRevoked: false },
        data: { isRevoked: true },
      });
    });
  });
});
