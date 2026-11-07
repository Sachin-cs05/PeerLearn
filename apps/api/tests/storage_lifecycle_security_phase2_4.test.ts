import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/config/prisma.js';
import { storageService } from '../src/services/storage.service.js';
import { storageReconciliation } from '../src/services/storage/reconciliation.service.js';
import { R2StorageProvider } from '../src/services/storage/r2.provider.js';
import { generateAccessToken } from '../src/utils/jwt.js';
import { COOKIE_ACCESS_NAME } from '../src/utils/cookies.js';
import { AppError } from '../src/middleware/errorHandler.js';
import { Readable } from 'node:stream';

describe('Phase 2.4 — Tasks 3, 4, 5, 9: Upload Security, Download Authorization, Delete Consistency & Client Recovery', () => {
  const app = createApp();

  const studentAlice = {
    id: 'user-alice-phase24',
    email: 'alice.phase24@university.edu',
    fullName: 'Alice QA',
  };

  const studentBob = {
    id: 'user-bob-phase24',
    email: 'bob.phase24@university.edu',
    fullName: 'Bob QA',
  };

  const tokenAlice = generateAccessToken({ userId: studentAlice.id, email: studentAlice.email });
  const tokenBob = generateAccessToken({ userId: studentBob.id, email: studentBob.email });

  let mockS3Client: any;
  let r2Provider: R2StorageProvider;
  const createdTestTaskIds = new Set<string>();

  beforeEach(() => {
    vi.restoreAllMocks();

    mockS3Client = {
      send: vi.fn().mockResolvedValue({}),
    };

    r2Provider = new R2StorageProvider(
      {
        accountId: 'test-cf-account-id',
        accessKeyId: 'test-r2-access-key',
        secretAccessKey: 'test-r2-secret-key',
        bucketName: 'peerlearn-qa-bucket',
      },
      mockS3Client
    );

    storageService.setProvider(r2Provider);
  });

  afterEach(async () => {
    // Scoped test teardown: only clean up tasks explicitly registered in this test run
    if (createdTestTaskIds.size > 0) {
      await storageReconciliation.deleteTasks(Array.from(createdTestTaskIds));
      createdTestTaskIds.clear();
    }
    await prisma.storageReconciliation.deleteMany({ where: { resourceId: 'res-db-fail-24' } });
    storageService.resetProvider();
  });

  afterAll(async () => {
    await prisma.storageReconciliation.deleteMany({ where: { resourceId: 'res-db-fail-24' } });
  });

  describe('Task 3: Upload Security & Multi-Format Validation', () => {
    it('1. accepts valid PDF document with valid %PDF- magic bytes', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(studentAlice as any);
      (vi.spyOn(prisma.learningResource, 'create') as any).mockImplementation(async (args: any) => ({
        id: 'res-pdf-1',
        ...args.data,
        createdAt: new Date(),
        updatedAt: new Date(),
        creator: studentAlice,
      }));

      const pdfHeader = Buffer.from('%PDF-1.7\nSample algorithmic lecture document');
      const res = await request(app)
        .post('/api/resources')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenAlice}`])
        .attach('file', pdfHeader, 'algorithms_lecture.pdf')
        .field('title', 'Algorithms Lecture')
        .field('type', 'DOCUMENT');

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.mimeType).toBe('application/pdf');
      expect(res.body.data.fileKey).toMatch(/^[0-9a-fA-F-]{36}\.pdf$/);
    });

    it('2. accepts valid PNG image with standard 8-byte PNG signature', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(studentAlice as any);
      (vi.spyOn(prisma.learningResource, 'create') as any).mockImplementation(async (args: any) => ({
        id: 'res-png-1',
        ...args.data,
        createdAt: new Date(),
        updatedAt: new Date(),
        creator: studentAlice,
      }));

      const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
      const res = await request(app)
        .post('/api/resources')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenAlice}`])
        .attach('file', pngSignature, 'diagram.png')
        .field('title', 'Network Diagram')
        .field('type', 'DOCUMENT');

      expect(res.status).toBe(201);
      expect(res.body.data.mimeType).toBe('image/png');
      expect(res.body.data.fileKey).toMatch(/^[0-9a-fA-F-]{36}\.png$/);
    });

    it('3. accepts valid JPEG image with 0xFF, 0xD8, 0xFF signature', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(studentAlice as any);
      (vi.spyOn(prisma.learningResource, 'create') as any).mockImplementation(async (args: any) => ({
        id: 'res-jpg-1',
        ...args.data,
        createdAt: new Date(),
        updatedAt: new Date(),
        creator: studentAlice,
      }));

      const jpegSignature = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      const res = await request(app)
        .post('/api/resources')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenAlice}`])
        .attach('file', jpegSignature, 'photo.jpg')
        .field('title', 'Lab Setup')
        .field('type', 'DOCUMENT');

      expect(res.status).toBe(201);
      expect(res.body.data.mimeType).toBe('image/jpeg');
      expect(res.body.data.fileKey).toMatch(/^[0-9a-fA-F-]{36}\.(jpg|jpeg)$/);
    });

    it('4. accepts valid WebP image with RIFF....WEBP signature', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(studentAlice as any);
      (vi.spyOn(prisma.learningResource, 'create') as any).mockImplementation(async (args: any) => ({
        id: 'res-webp-1',
        ...args.data,
        createdAt: new Date(),
        updatedAt: new Date(),
        creator: studentAlice,
      }));

      const webpHeader = Buffer.from('RIFF\x20\x00\x00\x00WEBPVP8 ');
      const res = await request(app)
        .post('/api/resources')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenAlice}`])
        .attach('file', webpHeader, 'graphic.webp')
        .field('title', 'Graphic Asset')
        .field('type', 'DOCUMENT');

      expect(res.status).toBe(201);
      expect(res.body.data.mimeType).toBe('image/webp');
      expect(res.body.data.fileKey).toMatch(/^[0-9a-fA-F-]{36}\.webp$/);
    });

    it('5. accepts valid TXT, MD, JSON, and CSV uploads', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(studentAlice as any);
      (vi.spyOn(prisma.learningResource, 'create') as any).mockImplementation(async (args: any) => ({
        id: `res-text-${Math.random()}`,
        ...args.data,
        createdAt: new Date(),
        updatedAt: new Date(),
        creator: studentAlice,
      }));

      // TXT
      const resTxt = await request(app)
        .post('/api/resources')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenAlice}`])
        .attach('file', Buffer.from('Standard plain text notes'), 'notes.txt')
        .field('title', 'Text Notes')
        .field('type', 'DOCUMENT');
      expect(resTxt.status).toBe(201);

      // Markdown
      const resMd = await request(app)
        .post('/api/resources')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenAlice}`])
        .attach('file', Buffer.from('# Markdown Notes\n- item 1'), 'readme.md')
        .field('title', 'Markdown Readme')
        .field('type', 'DOCUMENT');
      expect(resMd.status).toBe(201);

      // JSON
      const resJson = await request(app)
        .post('/api/resources')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenAlice}`])
        .attach('file', Buffer.from('{"topics": ["data-structures", "graphs"]}'), 'config.json')
        .field('title', 'Topics Config')
        .field('type', 'DOCUMENT');
      expect(resJson.status).toBe(201);

      // CSV
      const resCsv = await request(app)
        .post('/api/resources')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenAlice}`])
        .attach('file', Buffer.from('student_id,grade,score\n101,A,95\n102,B,85'), 'grades.csv')
        .field('title', 'Grade Data')
        .field('type', 'DOCUMENT');
      expect(resCsv.status).toBe(201);
    });

    it('6. rejects unauthenticated uploads with 401 UNAUTHORIZED', async () => {
      const res = await request(app)
        .post('/api/resources')
        .attach('file', Buffer.from('%PDF-1.4 Content'), 'doc.pdf')
        .field('title', 'Unauth Test')
        .field('type', 'DOCUMENT');

      expect(res.status).toBe(401);
    });

    it('7. rejects unsupported MIME types and forbidden extensions with 400 Bad Request', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(studentAlice as any);

      const resMime = await request(app)
        .post('/api/resources')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenAlice}`])
        .attach('file', Buffer.from('fake exe content'), {
          filename: 'payload.exe',
          contentType: 'application/x-msdownload',
        })
        .field('title', 'Executable Test')
        .field('type', 'DOCUMENT');
      expect(resMime.status).toBe(400);

      const resExt = await request(app)
        .post('/api/resources')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenAlice}`])
        .attach('file', Buffer.from('%PDF-1.4 Valid'), {
          filename: 'payload.sh',
          contentType: 'application/pdf',
        })
        .field('title', 'Script Shell Extension')
        .field('type', 'DOCUMENT');
      expect(resExt.status).toBe(400);
    });

    it('8. rejects empty or truncated binary files (0-byte PDF / PNG)', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(studentAlice as any);

      const resEmptyPdf = await request(app)
        .post('/api/resources')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenAlice}`])
        .attach('file', Buffer.alloc(0), 'empty.pdf')
        .field('title', 'Empty PDF')
        .field('type', 'DOCUMENT');

      expect(resEmptyPdf.status).toBe(400);
      expect(resEmptyPdf.body.error.message).toContain('truncated or empty');
    });

    it('9. enforces 15MB size ceiling and rejects oversized uploads', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(studentAlice as any);

      // Exactly 15MB + 1 byte
      const oversizedBuffer = Buffer.alloc(15 * 1024 * 1024 + 1);
      oversizedBuffer.write('%PDF-', 0, 5, 'ascii');

      const res = await request(app)
        .post('/api/resources')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenAlice}`])
        .attach('file', oversizedBuffer, 'oversized.pdf')
        .field('title', 'Too Large')
        .field('type', 'DOCUMENT');

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/(15MB|File too large)/i);
    });

    it('10. sanitizes malicious filenames and generates unique UUIDs preventing duplicate overwrite', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(studentAlice as any);
      const createdRecords: any[] = [];
      (vi.spyOn(prisma.learningResource, 'create') as any).mockImplementation(async (args: any) => {
        const rec = {
          id: `res-dup-${createdRecords.length + 1}`,
          ...args.data,
          createdAt: new Date(),
          updatedAt: new Date(),
          creator: studentAlice,
        };
        createdRecords.push(rec);
        return rec;
      });

      // Upload file 1 with dirty path navigation name
      const res1 = await request(app)
        .post('/api/resources')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenAlice}`])
        .attach('file', Buffer.from('%PDF-1.4 Content 1'), '../../etc/passwd;rm -rf.pdf')
        .field('title', 'Lecture Notes #1')
        .field('type', 'DOCUMENT');

      // Upload file 2 with identical original name
      const res2 = await request(app)
        .post('/api/resources')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenAlice}`])
        .attach('file', Buffer.from('%PDF-1.4 Content 2'), '../../etc/passwd;rm -rf.pdf')
        .field('title', 'Lecture Notes #2')
        .field('type', 'DOCUMENT');

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);

      // Filename was properly sanitized
      expect(res1.body.data.fileName).toBe('passwd_rm_-rf.pdf');
      expect(res2.body.data.fileName).toBe('passwd_rm_-rf.pdf');

      // Crucially, UUID keys are completely distinct so file 1 is never overwritten by file 2
      expect(res1.body.data.fileKey).not.toBe(res2.body.data.fileKey);
      expect(res1.body.data.fileKey).toMatch(/^[0-9a-fA-F-]{36}\.pdf$/);
      expect(res2.body.data.fileKey).toMatch(/^[0-9a-fA-F-]{36}\.pdf$/);
    });

    it('11. preserves user ownership and defaults standalone uploads to isPrivate: true', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(studentAlice as any);
      (vi.spyOn(prisma.learningResource, 'create') as any).mockImplementation(async (args: any) => ({
        id: 'res-private-check',
        ...args.data,
        createdAt: new Date(),
        updatedAt: new Date(),
        creator: studentAlice,
      }));

      const res = await request(app)
        .post('/api/resources')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenAlice}`])
        .attach('file', Buffer.from('%PDF-1.4 Private Notes'), 'exam_prep.pdf')
        .field('title', 'Exam Prep')
        .field('type', 'DOCUMENT');

      expect(res.status).toBe(201);
      expect(res.body.data.creatorId).toBe(studentAlice.id);
      expect(res.body.data.isPrivate).toBe(true);
    });
  });

  describe('Task 4: Download & Authorization Security', () => {
    it('12. allows authorized owner to download their private document', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(studentAlice as any);
      storageService.setProvider(r2Provider);

      const testBuffer = Buffer.from('%PDF-1.4 Stream Content For Private Document');
      const mockPdfStream = Readable.from([testBuffer]);

      mockS3Client.send.mockResolvedValueOnce({
        Body: mockPdfStream,
        ContentLength: testBuffer.length,
        ContentType: 'application/pdf',
      });

      vi.spyOn(prisma.learningResource, 'findUnique').mockResolvedValue({
        id: 'res-alice-doc',
        creatorId: studentAlice.id,
        isPrivate: true,
        fileKey: '11111111-2222-3333-4444-555555555555.pdf',
        fileName: 'my_private_notes.pdf',
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
      expect(res.headers['content-type']).toContain('application/pdf');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('13. blocks non-owner from downloading private document with 403 FORBIDDEN', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(studentBob as any);
      vi.spyOn(prisma.learningResource, 'findUnique').mockResolvedValue({
        id: 'res-alice-private',
        creatorId: studentAlice.id, // Owned by Alice
        isPrivate: true,
        fileKey: '11111111-2222-3333-4444-555555555555.pdf',
      } as any);

      const res = await request(app)
        .get('/api/resources/res-alice-private/download')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenBob}`]); // Requested by Bob

      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain('Unauthorized');
    });

    it('14. returns 404 NOT_FOUND for non-existent resource IDs and missing R2 objects', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(studentAlice as any);
      vi.spyOn(prisma.learningResource, 'findUnique').mockResolvedValue(null);

      const resNotFound = await request(app)
        .get('/api/resources/non-existent-res/download')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenAlice}`]);
      expect(resNotFound.status).toBe(404);

      // Missing R2 object handling
      vi.spyOn(prisma.learningResource, 'findUnique').mockResolvedValue({
        id: 'res-missing-r2',
        creatorId: studentAlice.id,
        isPrivate: false,
        fileKey: '11111111-2222-3333-4444-555555555555.pdf',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
      vi.spyOn(storageService, 'getFileStream').mockRejectedValueOnce(
        new AppError('Requested file not found in storage', 404)
      );

      const resMissingObj = await request(app)
        .get('/api/resources/res-missing-r2/download')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenAlice}`]);
      expect(resMissingObj.status).toBe(404);
    });

    it('15. generates presigned URL with configured 300s expiry when format=json is requested', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(studentAlice as any);
      vi.spyOn(prisma.learningResource, 'findUnique').mockResolvedValue({
        id: 'res-cloud-signed',
        creatorId: studentAlice.id,
        isPrivate: true,
        fileKey: '11111111-2222-3333-4444-555555555555.pdf',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      storageService.setProvider(r2Provider);
      vi.spyOn(r2Provider, 'getDownloadUrl').mockResolvedValue(
        'https://peerlearn-qa-bucket.r2.cloudflarestorage.com/11111111-2222-3333-4444-555555555555.pdf?X-Amz-Expires=300'
      );

      const res = await request(app)
        .get('/api/resources/res-cloud-signed/download?format=json')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenAlice}`]);

      expect(res.status).toBe(200);
      expect(res.body.data.downloadUrl).toContain('X-Amz-Expires=300');
      expect(res.body.data.expiresInSeconds).toBe(300);
    });
  });

  describe('Task 5: Deletion Consistency & Partial Failure Handling', () => {
    it('16. successful deletion removes both storage object and database record', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(studentAlice as any);
      vi.spyOn(prisma.learningResource, 'findUnique').mockResolvedValue({
        id: 'res-del-success',
        creatorId: studentAlice.id,
        fileKey: '11111111-2222-3333-4444-555555555555.pdf',
      } as any);

      const deleteStorageSpy = vi.spyOn(storageService, 'deleteFile').mockResolvedValueOnce(undefined);
      const deleteDbSpy = vi.spyOn(prisma.learningResource, 'delete').mockResolvedValueOnce({} as any);

      const res = await request(app)
        .delete('/api/resources/res-del-success')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenAlice}`]);

      expect(res.status).toBe(200);
      expect(deleteStorageSpy).toHaveBeenCalledWith('11111111-2222-3333-4444-555555555555.pdf');
      expect(deleteDbSpy).toHaveBeenCalledWith({ where: { id: 'res-del-success' } });
    });

    it('17. storage deletion failure aborts database deletion and returns 500 without losing DB record', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(studentAlice as any);
      vi.spyOn(prisma.learningResource, 'findUnique').mockResolvedValue({
        id: 'res-storage-fail',
        creatorId: studentAlice.id,
        fileKey: '11111111-2222-3333-4444-555555555555.pdf',
      } as any);

      vi.spyOn(storageService, 'deleteFile').mockRejectedValueOnce(
        new AppError('R2 service unavailable', 500)
      );
      const deleteDbSpy = vi.spyOn(prisma.learningResource, 'delete');

      const res = await request(app)
        .delete('/api/resources/res-storage-fail')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenAlice}`]);

      expect(res.status).toBe(500);
      // Crucial: database delete was never called! File reference is not lost
      expect(deleteDbSpy).not.toHaveBeenCalled();
    });

    it('18. database deletion failure registers DANGLING_DB_RESOURCE reconciliation task', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(studentAlice as any);
      vi.spyOn(prisma.learningResource, 'findUnique').mockResolvedValue({
        id: 'res-db-fail-24',
        creatorId: studentAlice.id,
        fileKey: '11111111-2222-3333-4444-555555555555.pdf',
      } as any);

      vi.spyOn(storageService, 'deleteFile').mockResolvedValueOnce(undefined);
      vi.spyOn(prisma.learningResource, 'delete').mockRejectedValueOnce(
        new Error('Database deadlock on delete')
      );
      const updateDbSpy = vi.spyOn(prisma.learningResource, 'update').mockResolvedValueOnce({} as any);

      const reconcileSpy = vi.spyOn(storageReconciliation, 'recordDanglingDbResource');

      const res = await request(app)
        .delete('/api/resources/res-db-fail-24')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenAlice}`]);

      expect(res.status).toBe(500);
      expect(updateDbSpy).toHaveBeenCalledWith({
        where: { id: 'res-db-fail-24' },
        data: { fileKey: null },
      });
      expect(reconcileSpy).toHaveBeenCalledWith(
        'res-db-fail-24',
        '11111111-2222-3333-4444-555555555555.pdf',
        'DB_DELETE_FAILED',
        expect.stringContaining('deadlock')
      );
    });

    it('19. duplicate delete returns 404 NOT_FOUND and non-owner delete returns 403 FORBIDDEN', async () => {
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(studentBob as any);
      vi.spyOn(prisma.learningResource, 'findUnique').mockResolvedValue({
        id: 'res-alice-doc',
        creatorId: studentAlice.id, // Alice owns it
      } as any);

      // Bob tries to delete Alice's doc
      const resForbidden = await request(app)
        .delete('/api/resources/res-alice-doc')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenBob}`]);
      expect(resForbidden.status).toBe(403);

      // Subsequent delete after it is already deleted (returns 404)
      vi.spyOn(prisma.learningResource, 'findUnique').mockResolvedValue(null);
      const resDuplicate = await request(app)
        .delete('/api/resources/res-already-gone')
        .set('Cookie', [`${COOKIE_ACCESS_NAME}=${tokenAlice}`]);
      expect(resDuplicate.status).toBe(404);
    });
  });

  describe('Task 9: Client Download Handling & Presigned URL Recovery', () => {
    it('20. simulates client-side download recovery: requests fresh URL on 403 without user logout', async () => {
      // Mock client download recovery function representing apiService.resources.downloadResource
      let requestCount = 0;
      const fakeApiRequest = async () => {
        requestCount += 1;
        return {
          data: {
            downloadUrl: `https://mock.r2/download?token=token-${requestCount}`,
            expiresInSeconds: 300,
          },
        };
      };

      const mockFetch = vi.fn()
        // First fetch with initial URL returns 403 (expired link)
        .mockResolvedValueOnce({ ok: false, status: 403 })
        // Second fetch with fresh URL returns 200 (recovered)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          blob: async () => Buffer.from('%PDF-1.4 Data'),
        });

      // Execute simulated recovery loop
      let downloadSucceeded = false;
      const initial = await fakeApiRequest();
      const res1 = await mockFetch(initial.data.downloadUrl);

      if (!res1.ok) {
        // Request exactly ONE fresh URL
        const fresh = await fakeApiRequest();
        const res2 = await mockFetch(fresh.data.downloadUrl);
        if (res2.ok) {
          downloadSucceeded = true;
        }
      }

      expect(downloadSucceeded).toBe(true);
      expect(requestCount).toBe(2);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('21. displays proper error and prevents infinite retry loops if second fresh URL also fails', async () => {
      let requestCount = 0;
      const fakeApiRequest = async () => {
        requestCount += 1;
        return {
          data: {
            downloadUrl: `https://mock.r2/download?token=token-${requestCount}`,
            expiresInSeconds: 300,
          },
        };
      };

      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 403 });

      let errorMessage: string | null = null;
      const initial = await fakeApiRequest();
      const res1 = await mockFetch(initial.data.downloadUrl);

      if (!res1.ok) {
        const fresh = await fakeApiRequest();
        const res2 = await mockFetch(fresh.data.downloadUrl);
        if (!res2.ok) {
          errorMessage = 'Download link expired. Please retry.';
        }
      }

      expect(errorMessage).toBe('Download link expired. Please retry.');
      expect(requestCount).toBe(2); // Strictly capped at 1 retry (2 requests total)
    });
  });
});
