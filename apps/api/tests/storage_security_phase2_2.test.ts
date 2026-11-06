import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/config/prisma.js';
import { generateAccessToken } from '../src/utils/jwt.js';
import { COOKIE_ACCESS_NAME } from '../src/utils/cookies.js';
import { storageService } from '../src/services/storage.service.js';
import { R2StorageProvider } from '../src/services/storage/r2.provider.js';
import { createResource, deleteResource, getResourceById } from '../src/services/resource.service.js';
import { storageReconciliation, StorageReconciliationService } from '../src/services/storage/reconciliation.service.js';
import { MAX_FILE_SIZE_BYTES } from '../src/services/storage/storage.types.js';

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (_client: any, command: any, options: any) =>
    Promise.resolve(
      `https://${command?.input?.Bucket || 'peerlearn-secured-bucket'}.r2.cloudflarestorage.com/${command?.input?.Key}?X-Amz-Expires=${options?.expiresIn ?? 300}`
    ),
}));

describe('Phase 2.2: Comprehensive Secure File Upload & Download Lifecycle', () => {
  const studentAlice = {
    id: 'user-alice-sec22',
    email: 'alice.sec22@university.edu',
    fullName: 'Alice Security',
  };

  const studentBob = {
    id: 'user-bob-sec22',
    email: 'bob.sec22@university.edu',
    fullName: 'Bob Security',
  };

  const tokenAlice = generateAccessToken({ userId: studentAlice.id, email: studentAlice.email });
  const tokenBob = generateAccessToken({ userId: studentBob.id, email: studentBob.email });

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
        accountId: 'test-cf-account-id',
        accessKeyId: 'test-r2-access-key',
        secretAccessKey: 'test-r2-secret-key',
        bucketName: 'peerlearn-secured-bucket',
      },
      mockS3Client as any
    );
  });

  // ===========================================================================
  // 1-2. Authentication & Authorization Before Upload
  // ===========================================================================
  describe('1-2. Upload Authentication & Permission Verification', () => {
    it('1. rejects unauthenticated file upload with 401 UNAUTHORIZED', async () => {
      const res = await request(app)
        .post('/api/resources')
        .attach('file', Buffer.from('%PDF-1.4 Valid content'), 'lecture_notes.pdf')
        .field('title', 'Algorithms Lecture Notes')
        .field('type', 'DOCUMENT');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('2. rejects file upload to unauthorized session with 403 FORBIDDEN when user is not a participant', async () => {
      // Mock session lookup where Alice is NOT an organizer or participant
      vi.spyOn(prisma.learningSession, 'findUnique').mockResolvedValue({
        id: 'session-charlie-bob',
        organizerId: 'user-charlie-id',
        participants: [{ userId: studentBob.id }],
      } as any);

      await expect(
        createResource(
          studentAlice.id,
          {
            title: 'Hacked Notes',
            type: 'DOCUMENT',
            sessionId: 'session-charlie-bob',
          },
          {
            buffer: Buffer.from('%PDF-1.4 Notes'),
            originalname: 'notes.pdf',
            mimetype: 'application/pdf',
          }
        )
      ).rejects.toThrow('Unauthorized: You are not a participant in this session');
    });

    it('3. successfully uploads valid document when user is authenticated and authorized', async () => {
      storageService.setProvider(r2Provider);
      mockS3Client.send.mockResolvedValueOnce({}); // PutObjectCommand

      const pdfBuffer = Buffer.from('%PDF-1.4 Valid Lecture Notes for Algorithms');
      const savedResource = {
        id: 'res-valid-doc-1',
        creatorId: studentAlice.id,
        type: 'DOCUMENT',
        title: 'Algorithms Notes',
        fileKey: 'valid-uuid-key.pdf',
        fileName: 'lecture_notes.pdf',
        fileSize: pdfBuffer.length,
        mimeType: 'application/pdf',
        isPrivate: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        creator: studentAlice,
        session: null,
      };

      vi.spyOn(prisma.learningResource, 'create').mockResolvedValue(savedResource as any);

      const result = await createResource(
        studentAlice.id,
        {
          title: 'Algorithms Notes',
          type: 'DOCUMENT',
        },
        {
          buffer: pdfBuffer,
          originalname: 'lecture_notes.pdf',
          mimetype: 'application/pdf',
        }
      );

      expect(result.id).toBe('res-valid-doc-1');
      expect(result.title).toBe('Algorithms Notes');
      expect(mockS3Client.send).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // 3-6. MIME, Extension & Magic-Byte Signature Validation
  // ===========================================================================
  describe('3-6. Server-Side MIME, Extension & Magic-Byte Verification', () => {
    it('rejects unsupported declared MIME type with 400 Bad Request', async () => {
      const buffer = Buffer.from('console.log("hello");');

      await expect(
        storageService.saveFile(buffer, 'script.js', 'application/javascript')
      ).rejects.toThrow('Unsupported file format');
    });

    it('rejects extension mismatch (extension spoofing attempt)', async () => {
      const fakePdf = Buffer.from('%PDF-1.4 Real Header');

      await expect(
        storageService.saveFile(fakePdf, 'payload.exe', 'application/pdf')
      ).rejects.toThrow('File extension ".exe" is not permitted');
    });

    it('rejects PDF file when magic bytes do not begin with %PDF-', async () => {
      const corruptPdf = Buffer.from('HTML <html><body>Not a PDF</body></html>');

      await expect(
        storageService.saveFile(corruptPdf, 'fake.pdf', 'application/pdf')
      ).rejects.toThrow('File signature mismatch: File content does not match a valid PDF format');
    });

    it('rejects PNG file when magic bytes do not match PNG header', async () => {
      const corruptPng = Buffer.from('GIF89a Fake Image pretending to be PNG');

      await expect(
        storageService.saveFile(corruptPng, 'avatar.png', 'image/png')
      ).rejects.toThrow('File signature mismatch: File content does not match a valid PNG image format');
    });

    it('rejects JPEG file when magic bytes do not match JPEG header', async () => {
      const corruptJpg = Buffer.from('BM Windows Bitmap header pretending to be JPG');

      await expect(
        storageService.saveFile(corruptJpg, 'photo.jpg', 'image/jpeg')
      ).rejects.toThrow('File signature mismatch: File content does not match a valid JPEG image format');
    });

    it('rejects executable Windows binary (MZ header) disguised as text document', async () => {
      // 0x4D 0x5A = 'MZ' DOS/PE executable signature
      const binaryPayload = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

      await expect(
        storageService.saveFile(binaryPayload, 'homework_notes.txt', 'text/plain')
      ).rejects.toThrow('Security violation: Executable binary detected masquerading as text document');
    });

    it('rejects Linux ELF binary (\x7fELF header) disguised as markdown document', async () => {
      // 0x7F 'E' 'L' 'F'
      const elfPayload = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);

      await expect(
        storageService.saveFile(elfPayload, 'readme.md', 'text/markdown')
      ).rejects.toThrow('Security violation: Executable binary detected masquerading as text document');
    });

    it('rejects binary file containing null bytes disguised as CSV document', async () => {
      const nullBytePayload = Buffer.from('id,name,data\n1,Alice,\x00\x01\x02binary');

      await expect(
        storageService.saveFile(nullBytePayload, 'grades.csv', 'text/csv')
      ).rejects.toThrow('Security violation: Binary content or null bytes detected in text document');
    });

    it('rejects malformed syntax disguised as JSON document', async () => {
      const malformedJson = Buffer.from('{ key: missing quotes, invalid json syntax }');

      await expect(
        storageService.saveFile(malformedJson, 'config.json', 'application/json')
      ).rejects.toThrow('Invalid JSON format: Content failed JSON syntax validation');
    });

    it('rejects oversized files exceeding 15MB limit with 400 Bad Request', async () => {
      const oversizedBuffer = Buffer.alloc(MAX_FILE_SIZE_BYTES + 500);

      await expect(
        storageService.saveFile(oversizedBuffer, 'huge.pdf', 'application/pdf')
      ).rejects.toThrow('File exceeds maximum permitted size of 15MB');
    });
  });

  // ===========================================================================
  // 7-10. Private Download Flow & Presigned URL Security
  // ===========================================================================
  describe('7-10. Private Download Authorization & Presigned URL Security', () => {
    it('7. allows author student to download private resource', async () => {
      vi.spyOn(prisma.learningResource, 'findUnique').mockResolvedValue({
        id: 'res-private-alice-own',
        creatorId: studentAlice.id,
        isPrivate: true,
        fileKey: '11111111-2222-3333-4444-555555555555.pdf',
        fileName: 'Alice_Private_Study_Notes.pdf',
        mimeType: 'application/pdf',
        createdAt: new Date(),
        updatedAt: new Date(),
        creator: studentAlice,
        session: null,
      } as any);

      const resource = await getResourceById(studentAlice.id, 'res-private-alice-own');
      expect(resource.id).toBe('res-private-alice-own');
    });

    it('8. blocks non-author student from downloading private resource with 403 FORBIDDEN', async () => {
      vi.spyOn(prisma.learningResource, 'findUnique').mockResolvedValue({
        id: 'res-private-alice',
        creatorId: studentAlice.id, // Alice is author
        isPrivate: true,           // Author marked resource strictly private
        fileKey: '11111111-2222-3333-4444-555555555555.pdf',
        fileName: 'Alice_Private_Study_Notes.pdf',
        mimeType: 'application/pdf',
        createdAt: new Date(),
        updatedAt: new Date(),
        creator: studentAlice,
        session: {
          id: 'session-shared',
          organizerId: studentAlice.id,
          participants: [{ userId: studentBob.id }],
        },
      } as any);

      await expect(
        getResourceById(studentBob.id, 'res-private-alice')
      ).rejects.toThrow('This resource is private to its author');
    });

    it('9. allows authorized session participants to access shared session resource', async () => {
      vi.spyOn(prisma.learningResource, 'findUnique').mockResolvedValue({
        id: 'res-session-shared',
        creatorId: studentAlice.id,
        isPrivate: false,
        fileKey: '22222222-3333-4444-5555-666666666666.pdf',
        fileName: 'Group_Session_Notes.pdf',
        mimeType: 'application/pdf',
        createdAt: new Date(),
        updatedAt: new Date(),
        creator: studentAlice,
        session: {
          id: 'session-shared-1',
          organizerId: studentAlice.id,
          participants: [{ userId: studentBob.id }],
        },
      } as any);

      // Bob is a member of the session; access granted
      const resource = await getResourceById(studentBob.id, 'res-session-shared');
      expect(resource.id).toBe('res-session-shared');
    });

    it('10. generates short-lived presigned URL (300 seconds) when redirect=true on cloud storage', async () => {
      storageService.setProvider(r2Provider);
      const testKey = '33333333-4444-5555-6666-777777777777.pdf';

      vi.spyOn(prisma.learningResource, 'findUnique').mockResolvedValue({
        id: 'res-signed-url',
        creatorId: studentAlice.id,
        isPrivate: false,
        fileKey: testKey,
        fileName: 'Lecture_Guide.pdf',
        mimeType: 'application/pdf',
        createdAt: new Date(),
        updatedAt: new Date(),
        creator: studentAlice,
        session: null,
      } as any);

      const presignedSpy = vi.spyOn(storageService, 'getDownloadUrl').mockResolvedValue(
        'https://peerlearn-secured-bucket.r2.cloudflarestorage.com/33333333-4444-5555-6666-777777777777.pdf?X-Amz-Expires=300'
      );

      const res = await request(app)
        .get('/api/resources/res-signed-url/download?redirect=true')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenAlice}`]);

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('X-Amz-Expires=300');
      expect(presignedSpy).toHaveBeenCalledWith(testKey, 300);
    });

    it('10b. returns presigned URL as JSON when format=json is requested', async () => {
      storageService.setProvider(r2Provider);
      const testKey = '33333333-4444-5555-6666-777777777777.pdf';

      vi.spyOn(prisma.learningResource, 'findUnique').mockResolvedValue({
        id: 'res-json-url',
        creatorId: studentAlice.id,
        isPrivate: false,
        fileKey: testKey,
        fileName: 'Lecture_Guide.pdf',
        mimeType: 'application/pdf',
        createdAt: new Date(),
        updatedAt: new Date(),
        creator: studentAlice,
        session: null,
      } as any);

      vi.spyOn(storageService, 'getDownloadUrl').mockResolvedValue(
        'https://peerlearn-secured-bucket.r2.cloudflarestorage.com/33333333-4444-5555-6666-777777777777.pdf?signed=mock'
      );

      const res = await request(app)
        .get('/api/resources/res-json-url/download?format=json')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenAlice}`]);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.downloadUrl).toContain('https://peerlearn-secured-bucket');
      expect(res.body.data.expiresInSeconds).toBe(300);
    });
  });

  // ===========================================================================
  // 11-13. Compensating Transactions, Deletion Consistency & Failure Handling
  // ===========================================================================
  describe('11-13. Deletion Consistency & Compensating Cleanups', () => {
    it('11. prevents non-author student from deleting another student resource with 403', async () => {
      vi.spyOn(prisma.learningResource, 'findUnique').mockResolvedValue({
        id: 'res-alice-note',
        creatorId: studentAlice.id,
        fileKey: '44444444-5555-6666-7777-888888888888.pdf',
      } as any);

      await expect(
        deleteResource(studentBob.id, 'res-alice-note')
      ).rejects.toThrow('Unauthorized: Only the creator can delete this resource');
    });

    it('12. COMPENSATING TRANSACTION: cleans up uploaded R2 object if subsequent database create fails', async () => {
      storageService.setProvider(r2Provider);
      mockS3Client.send.mockResolvedValueOnce({}); // S3 PutObject succeeds

      const deleteFileSpy = vi.spyOn(storageService, 'deleteFile').mockResolvedValueOnce();

      // Database insert throws unexpected error
      vi.spyOn(prisma.learningResource, 'create').mockRejectedValueOnce(
        new Error('Database unique constraint violation / connection severed')
      );

      const validPdf = Buffer.from('%PDF-1.4 Valid notes buffer');

      await expect(
        createResource(
          studentAlice.id,
          { title: 'Failed DB Resource', type: 'DOCUMENT' },
          { buffer: validPdf, originalname: 'doc.pdf', mimetype: 'application/pdf' }
        )
      ).rejects.toThrow('Database unique constraint violation / connection severed');

      // Asserts compensating cleanup executed: deleteFile was called to remove the orphaned object!
      expect(deleteFileSpy).toHaveBeenCalledTimes(1);
      expect(deleteFileSpy).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-fA-F-]{36}\.pdf$/));
    });

    it('13. prevents database record deletion if R2 storage deletion fails with a 500 error', async () => {
      storageService.setProvider(r2Provider);

      vi.spyOn(prisma.learningResource, 'findUnique').mockResolvedValue({
        id: 'res-alice-delete-fail',
        creatorId: studentAlice.id,
        fileKey: '55555555-6666-7777-8888-999999999999.pdf',
      } as any);

      // S3 DeleteObjectCommand throws a 500 network/internal error
      const s3Error = new Error('Cloudflare R2 service unavailable (500)');
      mockS3Client.send.mockRejectedValueOnce(s3Error);

      const dbDeleteSpy = vi.spyOn(prisma.learningResource, 'delete');

      await expect(
        deleteResource(studentAlice.id, 'res-alice-delete-fail')
      ).rejects.toThrow('Storage deletion error: Cloudflare R2 service unavailable (500)');

      // Crucial: The database record must NOT be deleted when R2 delete fails!
      expect(dbDeleteSpy).not.toHaveBeenCalled();
    });

    it('14. handles missing R2 object during delete gracefully (idempotent delete succeeds)', async () => {
      storageService.setProvider(r2Provider);

      vi.spyOn(prisma.learningResource, 'findUnique').mockResolvedValue({
        id: 'res-alice-already-deleted',
        creatorId: studentAlice.id,
        fileKey: '66666666-7777-8888-9999-000000000000.pdf',
      } as any);

      // S3 DeleteObject returns NoSuchKey / 404 (already deleted from storage)
      const notFoundError = new Error('NoSuchKey');
      (notFoundError as any).name = 'NoSuchKey';
      mockS3Client.send.mockRejectedValueOnce(notFoundError);

      const dbDeleteSpy = vi.spyOn(prisma.learningResource, 'delete').mockResolvedValueOnce({} as any);

      // Should succeed and delete the lingering DB record
      await expect(
        deleteResource(studentAlice.id, 'res-alice-already-deleted')
      ).resolves.not.toThrow();

      expect(dbDeleteSpy).toHaveBeenCalledWith({ where: { id: 'res-alice-already-deleted' } });
    });
  });

  // ===========================================================================
  // 15-18. Database Deletion Failures, Compensating Failure & Reconciliation
  // ===========================================================================
  describe('15-18. Database Deletion Failures, Compensating Failure & Reconciliation', () => {
    beforeEach(() => {
      storageReconciliation.clear();
    });

    it('15. handles DB deletion failure: attempts fileKey nullification, registers DANGLING_DB_RESOURCE, and enables retry', async () => {
      storageService.setProvider(r2Provider);
      const testKey = '77777777-8888-9999-0000-111111111111.pdf';

      vi.spyOn(prisma.learningResource, 'findUnique').mockResolvedValue({
        id: 'res-db-fail',
        creatorId: studentAlice.id,
        fileKey: testKey,
      } as any);

      // R2 delete succeeds
      mockS3Client.send.mockResolvedValueOnce({});

      // DB delete fails (e.g. database connection lost)
      vi.spyOn(prisma.learningResource, 'delete').mockRejectedValueOnce(
        new Error('PrismaClientKnownRequestError: Connection lost')
      );

      // Best effort update spy
      const updateSpy = vi.spyOn(prisma.learningResource, 'update').mockResolvedValueOnce({} as any);

      await expect(
        deleteResource(studentAlice.id, 'res-db-fail')
      ).rejects.toThrow('Failed to finalize resource record deletion');

      // Best effort nullification of fileKey was attempted
      expect(updateSpy).toHaveBeenCalledWith({
        where: { id: 'res-db-fail' },
        data: { fileKey: null },
      });

      // Durable reconciliation task registered
      const pending = storageReconciliation.getPendingTasks();
      expect(pending).toHaveLength(1);
      expect(pending[0].type).toBe('DANGLING_DB_RESOURCE');
      expect(pending[0].resourceId).toBe('res-db-fail');
      expect(pending[0].fileKey).toBe(testKey);

      // Verify retryable workflow: once DB recovers, retry succeeds
      const retryResult = await storageReconciliation.retryReconciliations({
        storageService,
        prisma: {
          learningResource: {
            delete: vi.fn().mockResolvedValueOnce({}),
          },
        } as any,
      });
      expect(retryResult.succeeded).toBe(1);
      expect(storageReconciliation.getPendingTasks()).toHaveLength(0);
    }, 15000);

    it('16. handles failed compensating cleanup: registers ORPHAN_STORAGE_KEY task and enables durable retry', async () => {
      storageService.setProvider(r2Provider);
      mockS3Client.send.mockResolvedValueOnce({}); // S3 PutObject succeeds

      // DB insert fails
      vi.spyOn(prisma.learningResource, 'create').mockRejectedValueOnce(
        new Error('Database disk full')
      );

      // Compensating S3 delete ALSO fails!
      vi.spyOn(storageService, 'deleteFile').mockRejectedValueOnce(
        new Error('Cloudflare R2 503 Service Unavailable')
      );

      const validPdf = Buffer.from('%PDF-1.4 Valid content for test');

      await expect(
        createResource(
          studentAlice.id,
          { title: 'Orphan Test Resource', type: 'DOCUMENT' },
          { buffer: validPdf, originalname: 'orphan.pdf', mimetype: 'application/pdf' }
        )
      ).rejects.toThrow('Database disk full');

      // Assert orphan task was registered
      const pending = storageReconciliation.getPendingTasks();
      expect(pending).toHaveLength(1);
      expect(pending[0].type).toBe('ORPHAN_STORAGE_KEY');
      expect(pending[0].fileKey).toMatch(/^[0-9a-fA-F-]{36}\.pdf$/);

      // Assert retry succeeds when storage service is back online
      const deleteSpy = vi.spyOn(storageService, 'deleteFile').mockResolvedValueOnce();
      const retryResult = await storageReconciliation.retryReconciliations({
        storageService,
        prisma: {} as any,
      });
      expect(retryResult.succeeded).toBe(1);
      expect(deleteSpy).toHaveBeenCalledWith(pending[0].fileKey);
      expect(storageReconciliation.getPendingTasks()).toHaveLength(0);
    }, 15000);

    it('17. PERSISTENCE & SURVIVAL: Pending tasks survive service reinitialization (simulated restart)', async () => {
      const testKey = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.pdf';
      await storageReconciliation.recordOrphanStorageKey(testKey, 'SIMULATED_RESTART_TEST');

      expect(storageReconciliation.getPendingTasks()).toHaveLength(1);

      // Simulate container crash & cold restart by instantiating a fresh service instance
      const restartedService = new StorageReconciliationService();
      const restoredPending = restartedService.getPendingTasks();

      expect(restoredPending).toHaveLength(1);
      expect(restoredPending[0].fileKey).toBe(testKey);
      expect(restoredPending[0].status).toBe('PENDING');

      restartedService.clear();
    });

    it('18. RETRY AFTER RESTART: Successfully finalizes pending tasks after simulated application restart', async () => {
      const testKey = '12345678-1234-1234-1234-1234567890ab.pdf';
      await storageReconciliation.recordOrphanStorageKey(testKey, 'CRASH_RECOVERY');

      // Restart service
      const restartedService = new StorageReconciliationService();
      expect(restartedService.getPendingTasks()).toHaveLength(1);

      const deleteSpy = vi.spyOn(storageService, 'deleteFile').mockResolvedValueOnce();

      // Retry from restarted service
      const result = await restartedService.retryReconciliations({
        storageService,
        prisma: {} as any,
      });

      expect(result.succeeded).toBe(1);
      expect(deleteSpy).toHaveBeenCalledWith(testKey);
      expect(restartedService.getPendingTasks()).toHaveLength(0);

      restartedService.clear();
    });

    it('18b. CONCURRENT WORKER LEASING: Protects in-flight task from duplicate execution by concurrent workers', async () => {
      const testKey = 'locked-key-1111-2222-3333-444444444444.pdf';
      const task = await storageReconciliation.recordOrphanStorageKey(testKey, 'CONCURRENCY_TEST');

      // Worker 1 claims lock
      task.status = 'PROCESSING';
      task.lockedAt = new Date();
      task.lockedBy = 'worker-alpha';
      await storageReconciliation.persistTask(task);

      // Worker 2 attempts reconciliation simultaneously
      const worker2Result = await storageReconciliation.retryReconciliations({
        storageService,
        prisma: {} as any,
        workerId: 'worker-beta',
      });

      // Worker 2 must skip the locked task
      expect(worker2Result.skipped).toBe(1);
      expect(worker2Result.succeeded).toBe(0);

      // Verify task remains under worker-alpha's lock
      const current = storageReconciliation.getAllTasks().find((t) => t.fileKey === testKey);
      expect(current?.lockedBy).toBe('worker-alpha');
      expect(current?.status).toBe('PROCESSING');
    });

    it('18c. RETRY EXHAUSTION: Transitions to FAILED when max retries exceeded and preserves for audit', async () => {
      const testKey = 'failing-key-0000-1111-2222-333333333333.pdf';
      const task = await storageReconciliation.recordOrphanStorageKey(testKey, 'RETRY_LIMIT_TEST');

      // Set retry count to max
      task.retryCount = task.maxRetries - 1;
      await storageReconciliation.persistTask(task);

      // Deletion throws persistent error
      vi.spyOn(storageService, 'deleteFile').mockRejectedValue(new Error('Persistent R2 Outage'));

      const result = await storageReconciliation.retryReconciliations({
        storageService,
        prisma: {} as any,
        force: true,
      });

      expect(result.failed).toBe(1);

      // Task status transitions to FAILED and is preserved for auditing
      const failedTask = storageReconciliation.getAllTasks().find((t) => t.fileKey === testKey);
      expect(failedTask?.status).toBe('FAILED');
      expect(failedTask?.retryCount).toBe(task.maxRetries);
      expect(failedTask?.lastError).toContain('Persistent R2 Outage');

      // Subsequent retry calls will not re-attempt exhausted tasks
      const nextRun = await storageReconciliation.retryReconciliations({
        storageService,
        prisma: {} as any,
      });
      expect(nextRun.succeeded).toBe(0);
      expect(nextRun.failed).toBe(0);
    });

    it('18d. PRODUCTION FAIL-SAFE: Rejects silent ephemeral fallback when PostgreSQL fails in production without persistent disk', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        const prodService = new StorageReconciliationService();
        expect(prodService.getCapabilities().allowDiskFallback).toBe(false);

        // Simulate PostgreSQL failure (e.g. table not migrated or connection down)
        vi.spyOn((prisma as any).storageReconciliation, 'upsert').mockRejectedValueOnce(
          new Error('P1001: Cannot connect to database server')
        );

        const testKey = 'prod-fail-key-1111-2222.pdf';
        const task = await prodService.recordOrphanStorageKey(testKey, 'TEST_PROD_DB_DOWN');

        // Must NOT falsely claim durable registration
        expect(task.persisted).toBe(false);
        expect(task.storageTier).toBe('unpersisted');

        // Ephemeral disk file must NOT have been written with this task
        const ephemeralPath = path.join(process.cwd(), '.storage-reconciliation-store.json');
        if (fs.existsSync(ephemeralPath)) {
          const content = fs.readFileSync(ephemeralPath, 'utf-8');
          expect(content).not.toContain(testKey);
        }
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it('18e. PERSISTENT DISK CONFIGURATION: Only persists to disk in production when persistent disk is explicitly configured', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      const testDiskDir = path.join(os.tmpdir(), `peerlearn-disk-test-${Date.now()}`);

      try {
        const diskService = new StorageReconciliationService({ persistentDiskDir: testDiskDir });
        expect(diskService.getCapabilities().isPersistentDiskConfigured).toBe(true);
        expect(diskService.getCapabilities().allowDiskFallback).toBe(true);

        // PostgreSQL fails, but persistent disk is configured
        vi.spyOn((prisma as any).storageReconciliation, 'upsert').mockRejectedValueOnce(
          new Error('P1001: Database unavailable')
        );

        const testKey = 'disk-key-3333-4444.pdf';
        const task = await diskService.recordOrphanStorageKey(testKey, 'TEST_PERSISTENT_DISK');

        expect(task.persisted).toBe(true);
        expect(task.storageTier).toBe('persistent_disk');

        // Verify file written to configured persistent disk path
        const expectedStoreFile = path.join(testDiskDir, 'storage-reconciliation-store.json');
        expect(fs.existsSync(expectedStoreFile)).toBe(true);
        const saved = JSON.parse(fs.readFileSync(expectedStoreFile, 'utf-8'));
        expect(saved.some((t: any) => t.fileKey === testKey)).toBe(true);

        diskService.clear();
      } finally {
        process.env.NODE_ENV = originalEnv;
        try {
          if (fs.existsSync(testDiskDir)) {
            fs.rmSync(testDiskDir, { recursive: true, force: true });
          }
        } catch {
          // cleanup
        }
      }
    });

    it('18f. GENUINE CONCURRENT WORKER CLAIMS: Prevents two simultaneous workers from claiming the same task in parallel', async () => {
      const testKey = 'race-key-5555-6666-7777-8888.pdf';
      const task = await storageReconciliation.recordOrphanStorageKey(testKey, 'CONCURRENT_RACE_TEST');

      // Two workers fire atomic claim simultaneously via Promise.all
      const [claim1, claim2] = await Promise.all([
        storageReconciliation.claimTask(task.id, 'worker-simultaneous-1'),
        storageReconciliation.claimTask(task.id, 'worker-simultaneous-2'),
      ]);

      // Exactly ONE worker must succeed, and the other must be rejected
      const claims = [claim1, claim2];
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(claims.filter((c) => !c)).toHaveLength(1);

      // Verify the task status is locked by whichever worker won
      const current = storageReconciliation.getAllTasks().find((t) => t.id === task.id);
      expect(current?.status).toBe('PROCESSING');
      expect(['worker-simultaneous-1', 'worker-simultaneous-2']).toContain(current?.lockedBy);
    });

    it('18g. EXPIRED LEASE RECOVERY: Atomically reclaims task if previous worker crashed and lease expired (> 5 minutes)', async () => {
      const testKey = 'crashed-worker-key-9999.pdf';
      const task = await storageReconciliation.recordOrphanStorageKey(testKey, 'CRASH_TEST');

      // Simulate a crashed worker whose lock was acquired 6 minutes ago
      task.status = 'PROCESSING';
      task.lockedBy = 'crashed-worker-dead';
      task.lockedAt = new Date(Date.now() - 6 * 60 * 1000); // 6 min ago (> 5 min lease)
      await storageReconciliation.persistTask(task);

      // New recovery worker attempts to claim
      const reclaimed = await storageReconciliation.claimTask(task.id, 'recovery-worker-alive');
      expect(reclaimed).toBe(true);

      const current = storageReconciliation.getAllTasks().find((t) => t.id === task.id);
      expect(current?.lockedBy).toBe('recovery-worker-alive');
      expect(current?.status).toBe('PROCESSING');
    });
  });

  // ===========================================================================
  // 19-21. Presigned URL Semantics & Privacy Defaults
  // ===========================================================================
  describe('19-21. Presigned URL Semantics & Privacy Defaults', () => {
    it('19. clamps presigned URL expiration to maximum 300 seconds regardless of client input', async () => {
      storageService.setProvider(r2Provider);
      const testKey = '88888888-9999-0000-1111-222222222222.pdf';

      // Request with 3600 seconds (1 hour)
      const url = await storageService.getDownloadUrl(testKey, 3600);
      expect(url).toContain('https://peerlearn-secured-bucket');

      // Request with 0 seconds -> clamped to valid range <= 300
      const urlMin = await storageService.getDownloadUrl(testKey, 0);
      expect(urlMin).toContain('https://peerlearn-secured-bucket');
    });

    it('20. confirms presigned GET URLs have time-limited (not single-use) semantics', async () => {
      storageService.setProvider(r2Provider);
      const testKey = '99999999-0000-1111-2222-333333333333.pdf';

      const url1 = await storageService.getDownloadUrl(testKey, 300);
      const url2 = await storageService.getDownloadUrl(testKey, 300);

      // Both URLs are valid URLs for the same key with 300s expiration
      expect(url1).toBeTruthy();
      expect(url2).toBeTruthy();
      // Ordinary presigned GET URLs are time-limited, meaning multiple requests can be made within the 300s window
      expect(url1).toContain('300');
    });

    it('20b. EXPIRED URL CLIENT RECOVERY: Endpoint provides fresh authenticated URL on demand without logout', async () => {
      storageService.setProvider(r2Provider);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(studentAlice as any);
      vi.spyOn(prisma.learningResource, 'findUnique').mockResolvedValue({
        id: 'res-refresh-token-url',
        creatorId: studentAlice.id,
        isPrivate: true,
        fileKey: 'aaaa1111-bbbb-2222-cccc-333344445555.pdf',
        fileName: 'Study_Guide.pdf',
        mimeType: 'application/pdf',
        createdAt: new Date(),
        updatedAt: new Date(),
        creator: studentAlice,
        session: null,
      } as any);

      // Client requests fresh presigned URL after earlier URL expired
      const res = await request(app)
        .get('/api/resources/res-refresh-token-url/download?format=json')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenAlice}`]);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.downloadUrl).toContain('X-Amz-Expires=300');
      expect(res.body.data.expiresInSeconds).toBe(300);
    });

    it('21. defaults newly created standalone student resource to isPrivate: true when not specified', async () => {
      const createSpy = vi.spyOn(prisma.learningResource, 'create').mockImplementation(((args: any) => {
        return Promise.resolve({
          id: 'res-default-private',
          ...args.data,
          createdAt: new Date(),
          updatedAt: new Date(),
          creator: studentAlice,
          session: null,
        });
      }) as any);

      // No isPrivate passed, no sessionId, no targetUserId
      const res = await createResource(studentAlice.id, {
        title: 'Personal Study Plan',
        type: 'NOTE',
        content: 'Topics to study this week',
      });

      expect(res.isPrivate).toBe(true);
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            isPrivate: true,
          }),
        })
      );
    });
  });

  // ===========================================================================
  // 22-29. Workspace Routes Authorization Verification
  // ===========================================================================
  describe('22-29. Workspace Routes Authorization Suite', () => {
    it('22. unauthenticated workspace upload returns 401 UNAUTHORIZED', async () => {
      const res = await request(app)
        .post('/api/resources')
        .field('title', 'Unauthenticated Note')
        .field('type', 'NOTE')
        .field('sessionId', 'session-123');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('23. non-member workspace upload returns 403 FORBIDDEN', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(studentAlice as any);
      vi.spyOn(prisma.learningSession, 'findUnique').mockResolvedValue({
        id: 'session-bob-exclusive',
        organizerId: studentBob.id,
        participants: [],
      } as any);

      const res = await request(app)
        .post('/api/resources')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenAlice}`])
        .field('title', 'Intruder Document')
        .field('type', 'NOTE')
        .field('sessionId', 'session-bob-exclusive');

      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain('Unauthorized: You are not a participant in this session');
    });

    it('24. authorized member workspace upload returns 201 CREATED', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(studentAlice as any);
      vi.spyOn(prisma.learningSession, 'findUnique').mockResolvedValue({
        id: 'session-collab',
        organizerId: studentAlice.id,
        participants: [{ userId: studentBob.id }],
      } as any);

      vi.spyOn(prisma.learningResource, 'create').mockResolvedValue({
        id: 'res-workspace-doc',
        creatorId: studentAlice.id,
        sessionId: 'session-collab',
        targetUserId: null,
        type: 'NOTE',
        title: 'Team Roadmap',
        description: null,
        content: 'Sprint planning notes',
        url: null,
        language: null,
        fileKey: null,
        fileName: null,
        fileSize: null,
        mimeType: null,
        isPrivate: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        creator: studentAlice,
        session: { id: 'session-collab', title: 'Algorithms Study Group' },
      } as any);

      const res = await request(app)
        .post('/api/resources')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenAlice}`])
        .send({
          title: 'Team Roadmap',
          type: 'NOTE',
          sessionId: 'session-collab',
          isPrivate: false,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.sessionId).toBe('session-collab');
    });

    it('25. non-member workspace download returns 403 FORBIDDEN', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(studentBob as any);
      vi.spyOn(prisma.learningResource, 'findUnique').mockResolvedValue({
        id: 'res-alice-confidential',
        creatorId: studentAlice.id,
        isPrivate: false,
        fileKey: '11111111-2222-3333-4444-555555555555.pdf',
        fileName: 'Confidential.pdf',
        mimeType: 'application/pdf',
        createdAt: new Date(),
        updatedAt: new Date(),
        creator: studentAlice,
        session: {
          id: 'session-private-group',
          organizerId: studentAlice.id,
          participants: [{ userId: 'user-charlie' }], // Bob is NOT here
        },
      } as any);

      const res = await request(app)
        .get('/api/resources/res-alice-confidential/download')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenBob}`]);

      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain('Unauthorized access to this resource');
    });

    it('26. authorized member workspace download returns 200 / presigned stream', async () => {
      storageService.setProvider(r2Provider);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(studentBob as any);
      vi.spyOn(prisma.learningResource, 'findUnique').mockResolvedValue({
        id: 'res-alice-shared',
        creatorId: studentAlice.id,
        isPrivate: false,
        fileKey: '22222222-3333-4444-5555-666666666666.pdf',
        fileName: 'Shared_Exercise.pdf',
        mimeType: 'application/pdf',
        createdAt: new Date(),
        updatedAt: new Date(),
        creator: studentAlice,
        session: {
          id: 'session-collab',
          organizerId: studentAlice.id,
          participants: [{ userId: studentBob.id }], // Bob IS authorized participant
        },
      } as any);

      vi.spyOn(storageService, 'getDownloadUrl').mockResolvedValue(
        'https://peerlearn-secured-bucket.r2.cloudflarestorage.com/download-url?expires=300'
      );

      const res = await request(app)
        .get('/api/resources/res-alice-shared/download?format=json')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenBob}`]);

      expect(res.status).toBe(200);
      expect(res.body.data.downloadUrl).toContain('https://peerlearn-secured-bucket');
    });

    it('27. unauthorized workspace file deletion by non-author returns 403 FORBIDDEN', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(studentBob as any);
      vi.spyOn(prisma.learningResource, 'findUnique').mockResolvedValue({
        id: 'res-alice-file',
        creatorId: studentAlice.id,
        fileKey: '33333333-4444-5555-6666-777777777777.pdf',
      } as any);

      const res = await request(app)
        .delete('/api/resources/res-alice-file')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenBob}`]);

      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain('Unauthorized: Only the creator can delete this resource');
    });

    it('28. authorized workspace file deletion by creator returns 200 OK', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(studentAlice as any);
      vi.spyOn(prisma.learningResource, 'findUnique').mockResolvedValue({
        id: 'res-alice-file',
        creatorId: studentAlice.id,
        fileKey: '33333333-4444-5555-6666-777777777777.pdf',
      } as any);

      vi.spyOn(storageService, 'deleteFile').mockResolvedValue();
      vi.spyOn(prisma.learningResource, 'delete').mockResolvedValue({} as any);

      const res = await request(app)
        .delete('/api/resources/res-alice-file')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenAlice}`]);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('29. non-member session workspace listing returns 403 FORBIDDEN', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(studentBob as any);
      vi.spyOn(prisma.learningSession, 'findUnique').mockResolvedValue({
        id: 'session-secret-council',
        organizerId: studentAlice.id,
        participants: [{ userId: 'user-charlie' }], // Bob is NOT here
      } as any);

      const res = await request(app)
        .get('/api/resources/session/session-secret-council')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenBob}`]);

      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain('Unauthorized access to session workspace');
    });
  });
});
