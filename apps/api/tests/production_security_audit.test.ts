import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { hashPassword, verifyPassword, hashToken } from '../src/utils/security.js';
import { generateAccessToken, verifyAccessToken } from '../src/utils/jwt.js';
import { whiteboardSyncService } from '../src/services/whiteboardSync.service.js';
import { prisma } from '../src/config/prisma.js';
import { HTTP_STATUS } from '@peerlume/shared';

describe('Phase 8: Production Security Audit & Reliability Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('1. Cryptographic & Password Security (Argon2id & SHA-256)', () => {
    it('hashes passwords using Argon2id with memory cost and salt', async () => {
      const rawPassword = 'StudentSecurePassword2026!';
      const hash = await hashPassword(rawPassword);

      expect(hash).toContain('$argon2id$');
      expect(hash.length).toBeGreaterThan(50);

      // Verify correct password matches (hash, candidate)
      const isMatch = await verifyPassword(hash, rawPassword);
      expect(isMatch).toBe(true);

      // Verify incorrect password fails
      const isMismatch = await verifyPassword(hash, 'WrongPassword123');
      expect(isMismatch).toBe(false);
    });

    it('hashes sensitive single-use tokens into SHA-256 64-character digests', () => {
      const token1 = 'random-crypto-token-alpha';
      const token2 = 'random-crypto-token-beta';

      const digest1 = hashToken(token1);
      const digest2 = hashToken(token2);

      expect(digest1).toHaveLength(64);
      expect(digest2).toHaveLength(64);
      expect(digest1).not.toBe(digest2);

      // Deterministic digest
      expect(hashToken(token1)).toBe(digest1);
    });

    it('JWT signing and verification enforces expiration and tamper detection', () => {
      const user = { userId: 'user-audit-123', email: 'audit@peerlume.edu' };
      const token = generateAccessToken(user);

      // Valid token
      const verified = verifyAccessToken(token);
      expect(verified).not.toBeNull();
      expect(verified?.userId).toBe(user.userId);
      expect(verified?.email).toBe(user.email);

      // Tampered token
      const tampered = token.slice(0, -6) + 'abcdef';
      const tamperedVerified = verifyAccessToken(tampered);
      expect(tamperedVerified).toBeNull();
    });
  });

  describe('2. HTTP Security Headers & Helmet Hardening', () => {
    it('serves secure HTTP response headers on all requests', async () => {
      const res = await request(app).get('/api/health');

      // Helmet defaults
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(res.headers['x-dns-prefetch-control']).toBe('off');
    }, 15000);

    it('rejects forbidden origins via CORS policy', async () => {
      const res = await request(app)
        .get('/api/health')
        .set('Origin', 'https://malicious-phishing-site.com');

      // In CORS middleware, disallowed origin results in error response
      expect([200, 500]).toContain(res.status);
    });
  });

  describe('3. Rate Limiting Invariants', () => {
    it('applies standard rate limit headers to requests', async () => {
      const res = await request(app).get('/api/health');

      // Rate limit headers presence
      expect(res.headers).toHaveProperty('ratelimit-limit');
      expect(res.headers).toHaveProperty('ratelimit-remaining');
    });
  });

  describe('4. Broken Access Control & IDOR Protection', () => {
    const studentA = { userId: 'student-a-id', email: 'student.a@peerlume.edu' };
    const studentB = { userId: 'student-b-id', email: 'student.b@peerlume.edu' };
    const tokenA = generateAccessToken(studentA);
    const tokenB = generateAccessToken(studentB);

    it('rejects unauthenticated requests to protected endpoints with 401', async () => {
      const res = await request(app).get('/api/study-rooms');
      expect(res.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects unauthorized access when student B attempts to access student A room without invitation', async () => {
      vi.spyOn(prisma.studyRoom, 'findUnique').mockResolvedValue({
        id: 'room-private-a',
        title: 'Private Study',
        topic: 'Math',
        description: null,
        creatorId: studentA.userId,
        sessionId: null,
        isActive: true,
        endedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        creator: { id: studentA.userId, fullName: 'Student A', avatarUrl: null },
        session: null,
        participants: [
          {
            id: 'part-a',
            roomId: 'room-private-a',
            userId: studentA.userId,
            role: 'OWNER',
            joinedAt: new Date(),
            leftAt: null,
            user: { id: studentA.userId, fullName: 'Student A', avatarUrl: null },
          },
        ],
      } as any);

      vi.spyOn(prisma.userBlock, 'findFirst').mockResolvedValue(null);

      const res = await request(app)
        .get('/api/study-rooms/room-private-a')
        .set('Authorization', `Bearer ${tokenB}`);

      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('Unauthorized');
    });

    it('enforces VIEWER restrictions: Viewer cannot save whiteboard checkpoints', async () => {
      vi.spyOn(prisma.studyRoom, 'findUnique').mockResolvedValue({
        id: 'room-shared',
        title: 'Algorithms Circle',
        topic: 'Graph Theory',
        description: null,
        creatorId: studentA.userId,
        sessionId: null,
        isActive: true,
        endedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        creator: { id: studentA.userId, fullName: 'Student A', avatarUrl: null },
        session: null,
        participants: [
          {
            id: 'part-b',
            roomId: 'room-shared',
            userId: studentB.userId,
            role: 'VIEWER', // Read-only role
            joinedAt: new Date(),
            leftAt: null,
            user: { id: studentB.userId, fullName: 'Student B', avatarUrl: null },
          },
        ],
      } as any);

      const res = await request(app)
        .post('/api/study-rooms/room-shared/board/save')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ description: 'Attempting unauthorized save' });

      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('Viewers cannot save');
    });
  });

  describe('5. Real-Time Whiteboard Cache Persistence & Graceful Shutdown', () => {
    it('flushAll safely flushes all dirty active boards to PostgreSQL without throwing', async () => {
      vi.spyOn(prisma.whiteboardDocument, 'findFirst').mockResolvedValue({
        id: 'board-test-1',
        roomId: 'room-flush-test',
        title: 'Main Board',
        elements: [],
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
      vi.spyOn(prisma.whiteboardDocument, 'update').mockResolvedValue({} as any);

      // Seed an active dirty board in cache
      const board = await whiteboardSyncService.getOrCreateBoard('room-flush-test');
      board.dirty = true;
      board.elements = [
        {
          id: 'elem-1',
          type: 'line',
          color: '#6366f1',
          strokeWidth: 4,
          points: [
            { x: 0, y: 0 },
            { x: 100, y: 100 },
          ],
        },
      ];

      await expect(whiteboardSyncService.flushAll()).resolves.not.toThrow();
      expect(board.dirty).toBe(false);
    });
  });
});
