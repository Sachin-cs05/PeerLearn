import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { Readable } from 'node:stream';
import { app } from '../src/app.js';
import { prisma } from '../src/config/prisma.js';
import { env } from '../src/config/env.js';
import { generateAccessToken } from '../src/utils/jwt.js';
import { COOKIE_ACCESS_NAME } from '../src/utils/cookies.js';
import { storageService } from '../src/services/storage.service.js';
import { R2StorageProvider } from '../src/services/storage/r2.provider.js';
import { LocalStorageProvider } from '../src/services/storage/local.provider.js';
import { MAX_FILE_SIZE_BYTES } from '../src/services/storage/storage.types.js';
import { AppError } from '../src/middleware/errorHandler.js';

describe('Phase 2.1: Cloudflare R2 Storage Integration & Provider Abstraction', () => {
  const studentAlice = {
    id: 'student-storage-alice',
    email: 'alice.storage@peerlearn.edu',
    fullName: 'Alice Storage',
  };

  const studentBob = {
    id: 'student-storage-bob',
    email: 'bob.storage@peerlearn.edu',
    fullName: 'Bob Storage',
  };

  let mockS3Client: any;
  let r2Provider: R2StorageProvider;

  beforeEach(() => {
    vi.restoreAllMocks();
    storageService.resetProvider();

    mockS3Client = {
      send: vi.fn(),
    };

    r2Provider = new R2StorageProvider(
      {
        accountId: 'test-cf-account-id-12345',
        accessKeyId: 'test-r2-access-key-id',
        secretAccessKey: 'test-r2-secret-key-mock',
        bucketName: 'peerlearn-student-bucket',
      },
      mockS3Client as any
    );
  });

  // ===========================================================================
  // 1. R2 Client Configuration & Instantiation
  // ===========================================================================
  describe('1. R2 Client Configuration', () => {
    it('initializes R2 client with S3-compatible configuration and auto region', () => {
      const provider = new R2StorageProvider({
        accountId: 'abc-123',
        accessKeyId: 'key-id',
        secretAccessKey: 'secret-key',
        bucketName: 'test-bucket',
      });

      expect(provider.name).toBe('r2');
      expect(provider.getBucketName()).toBe('test-bucket');
      expect(provider.getClient()).toBeDefined();
    });
  });

  // ===========================================================================
  // 2-4: Core CRUD Operations (Upload, Download, Delete)
  // ===========================================================================
  describe('2-4. Core R2 Storage Operations', () => {
    it('2. successfully uploads buffer to R2 via PutObjectCommand', async () => {
      mockS3Client.send.mockResolvedValueOnce({});
      const testBuffer = Buffer.from('%PDF-1.4 Mock PDF Content');

      await r2Provider.upload('file-1234.pdf', testBuffer, 'application/pdf');

      expect(mockS3Client.send).toHaveBeenCalledTimes(1);
      const commandArg = mockS3Client.send.mock.calls[0][0];
      expect(commandArg.input).toEqual(
        expect.objectContaining({
          Bucket: 'peerlearn-student-bucket',
          Key: 'file-1234.pdf',
          Body: testBuffer,
          ContentType: 'application/pdf',
        })
      );
    });

    it('3. handles failed R2 upload by throwing safe AppError without exposing internal stack', async () => {
      mockS3Client.send.mockRejectedValueOnce(new Error('Connection timeout to Cloudflare R2 endpoint'));
      const testBuffer = Buffer.from('hello world');

      await expect(
        r2Provider.upload('file-err.txt', testBuffer, 'text/plain')
      ).rejects.toThrow('Storage error: Failed to save file');
    });

    it('4. successfully deletes object from R2 via DeleteObjectCommand', async () => {
      mockS3Client.send.mockResolvedValueOnce({});

      await r2Provider.delete('file-to-delete.pdf');

      expect(mockS3Client.send).toHaveBeenCalledTimes(1);
      const commandArg = mockS3Client.send.mock.calls[0][0];
      expect(commandArg.input).toEqual(
        expect.objectContaining({
          Bucket: 'peerlearn-student-bucket',
          Key: 'file-to-delete.pdf',
        })
      );
    });
  });

  // ===========================================================================
  // 5. Fail-Fast on Missing Configuration & Production Ephemeral Ban
  // ===========================================================================
  describe('5. Configuration Validation & Production Ephemeral Ban', () => {
    it('fails clearly when R2 is configured but required credentials are missing', () => {
      const origProvider = env.STORAGE_PROVIDER;
      try {
        (env as any).STORAGE_PROVIDER = 'r2';
        (env as any).R2_ACCOUNT_ID = ''; // Missing!

        expect(() => storageService.resetProvider()).toThrow(
          'STORAGE_PROVIDER is configured as "r2", but required R2 credentials are missing'
        );
      } finally {
        (env as any).STORAGE_PROVIDER = origProvider;
        storageService.resetProvider();
      }
    });

    it('prohibits local ephemeral filesystem storage in production environment', () => {
      const origEnv = env.NODE_ENV;
      const origProvider = env.STORAGE_PROVIDER;
      try {
        (env as any).NODE_ENV = 'production';
        (env as any).STORAGE_PROVIDER = 'local';

        expect(() => storageService.resetProvider()).toThrow(
          'CRITICAL: Local ephemeral filesystem storage is prohibited in production'
        );
      } finally {
        (env as any).NODE_ENV = origEnv;
        (env as any).STORAGE_PROVIDER = origProvider;
        storageService.resetProvider();
      }
    });
  });

  // ===========================================================================
  // 6-8: Upload Security & Key Sanitization
  // ===========================================================================
  describe('6-8. File Upload Security & Validation', () => {
    it('6. rejects unsupported MIME type with 400 Bad Request', async () => {
      const maliciousBuffer = Buffer.from('MZ... executable content');

      await expect(
        storageService.saveFile(maliciousBuffer, 'malware.exe', 'application/x-msdownload')
      ).rejects.toThrow('Unsupported file format');
    });

    it('6b. rejects extension mismatch (e.g. executable extension claiming pdf mime)', async () => {
      const spoofedBuffer = Buffer.from('fake pdf content');

      await expect(
        storageService.saveFile(spoofedBuffer, 'exploit.sh', 'application/pdf')
      ).rejects.toThrow('File extension ".sh" is not permitted');
    });

    it('7. rejects oversized files exceeding 15MB limit with 400 Bad Request', async () => {
      const oversizedBuffer = Buffer.alloc(MAX_FILE_SIZE_BYTES + 1024);

      await expect(
        storageService.saveFile(oversizedBuffer, 'huge_dataset.csv', 'text/csv')
      ).rejects.toThrow('File exceeds maximum permitted size of 15MB');
    });

    it('8. generates safe, unguessable UUID storage keys and strips directory traversal paths', async () => {
      storageService.setProvider(r2Provider);
      mockS3Client.send.mockResolvedValueOnce({});

      const samplePdf = Buffer.from('%PDF-1.4 Data Structures Notes');
      const maliciousFilename = '../../../../etc/passwd_notes.pdf';

      const result = await storageService.saveFile(samplePdf, maliciousFilename, 'application/pdf');

      // Key must be random UUID with .pdf
      expect(result.fileKey).toMatch(/^[0-9a-fA-F-]{36}\.pdf$/);
      // Original filename stripped of traversal characters
      expect(result.originalName).not.toContain('..');
      expect(result.originalName).not.toContain('/');
      expect(result.originalName).not.toContain('\\');
      expect(result.sizeBytes).toBe(samplePdf.length);
    });
  });

  // ===========================================================================
  // 9-11: Private File Access & Authorization Enforcement
  // ===========================================================================
  describe('9-11. File Access Control & Authorization', () => {
    it('9. blocks non-author student from downloading private resource with 403', async () => {
      const tokenBob = generateAccessToken({ userId: studentBob.id, email: studentBob.email });

      vi.spyOn(prisma.learningResource, 'findUnique').mockResolvedValue({
        id: 'res-private-alice',
        creatorId: studentAlice.id, // Owned by Alice
        isPrivate: true,           // Marked PRIVATE
        fileKey: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf',
        fileName: 'Alice_Private_Study_Notes.pdf',
        mimeType: 'application/pdf',
        fileSize: 1024,
        creator: studentAlice,
        session: null,
      } as any);

      const res = await request(app)
        .get('/api/resources/res-private-alice/download')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenBob}`]);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('10. rejects unauthenticated download attempt with 401', async () => {
      const res = await request(app).get('/api/resources/res-some-id/download');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('11. prevents non-author student from deleting another student resource with 403', async () => {
      const tokenBob = generateAccessToken({ userId: studentBob.id, email: studentBob.email });

      vi.spyOn(prisma.learningResource, 'findUnique').mockResolvedValue({
        id: 'res-alice-shared',
        creatorId: studentAlice.id, // Alice is creator
        fileKey: 'b2c3d4e5-f6a7-8901-bcde-f12345678901.pdf',
      } as any);

      const res = await request(app)
        .delete('/api/resources/res-alice-shared')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenBob}`]);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });
  });

  // ===========================================================================
  // 12. Missing Object Handling
  // ===========================================================================
  describe('12. Missing Object Handling', () => {
    it('returns clean 404 when requested object does not exist in R2', async () => {
      const notFoundError = new Error('NoSuchKey');
      (notFoundError as any).name = 'NoSuchKey';
      mockS3Client.send.mockRejectedValueOnce(notFoundError);

      await expect(
        r2Provider.download('00000000-0000-0000-0000-000000000000.pdf')
      ).rejects.toThrow('Requested file not found in storage');
    });

    it('exists() returns false when object is not found in R2', async () => {
      const notFoundError = new Error('NotFound');
      (notFoundError as any).name = 'NotFound';
      mockS3Client.send.mockRejectedValueOnce(notFoundError);

      const exists = await r2Provider.exists('00000000-0000-0000-0000-000000000000.pdf');
      expect(exists).toBe(false);
    });
  });

  // ===========================================================================
  // 13. API Compatibility & Streaming Response
  // ===========================================================================
  describe('13. Storage Service Contract Compatibility', () => {
    it('streams R2 object through Express download endpoint to authorized student', async () => {
      const tokenAlice = generateAccessToken({ userId: studentAlice.id, email: studentAlice.email });
      storageService.setProvider(r2Provider);

      const testBuffer = Buffer.from('%PDF-1.4 Mock Stream Data Chunk 1 and Chunk 2');
      const mockPdfStream = Readable.from([testBuffer]);

      mockS3Client.send.mockResolvedValueOnce({
        Body: mockPdfStream,
        ContentLength: testBuffer.length,
        ContentType: 'application/pdf',
      });

      vi.spyOn(prisma.learningResource, 'findUnique').mockResolvedValue({
        id: 'res-alice-doc',
        creatorId: studentAlice.id,
        isPrivate: false,
        fileKey: '11111111-2222-3333-4444-555555555555.pdf',
        fileName: 'Alice_Algorithms_CheatSheet.pdf',
        mimeType: 'application/pdf',
        fileSize: testBuffer.length,
        createdAt: new Date(),
        updatedAt: new Date(),
        creator: studentAlice,
        session: null,
      } as any);

      const res = await request(app)
        .get('/api/resources/res-alice-doc/download')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenAlice}`]);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-disposition']).toContain('Alice_Algorithms_CheatSheet.pdf');
    });
  });

  // ===========================================================================
  // 14. Local Development Provider Security
  // ===========================================================================
  describe('14. Local Development Provider Behavior', () => {
    it('operates local filesystem provider in dev/test environment', async () => {
      const localProvider = new LocalStorageProvider();
      expect(localProvider.name).toBe('local');

      const testBuffer = Buffer.from('Local storage test file');
      const testKey = '12345678-1234-1234-1234-1234567890ab.txt';

      await localProvider.upload(testKey, testBuffer);
      expect(await localProvider.exists(testKey)).toBe(true);

      const downloadResult = await localProvider.download(testKey);
      expect(downloadResult.size).toBe(testBuffer.length);

      // Consume stream to ensure file descriptor closes cleanly before deletion
      for await (const _chunk of downloadResult.stream) {
        // stream drained
      }

      await localProvider.delete(testKey);
      expect(await localProvider.exists(testKey)).toBe(false);
    });

    it('rejects path traversal attempts on local provider with 400 Bad Request', async () => {
      const localProvider = new LocalStorageProvider();

      await expect(
        localProvider.download('../../etc/passwd.txt')
      ).rejects.toThrow('Invalid storage key format');

      await expect(
        localProvider.delete('../../secret.env')
      ).resolves.not.toThrow(); // Delete safely ignores invalid keys
    });
  });
});
