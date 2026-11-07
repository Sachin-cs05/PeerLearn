import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { R2StorageProvider } from '../src/services/storage/r2.provider.js';
import { LocalStorageProvider } from '../src/services/storage/local.provider.js';
import { storageService } from '../src/services/storage.service.js';
import { AppError } from '../src/middleware/errorHandler.js';

describe('Phase 2.4 — Task 2: Storage Unit Testing', () => {
  describe('A & B. R2StorageProvider Unit Tests', () => {
    let mockS3Client: any;
    let r2Provider: R2StorageProvider;

    beforeEach(() => {
      mockS3Client = {
        send: vi.fn(),
      };
      r2Provider = new R2StorageProvider(
        {
          accountId: 'mock-account-id',
          accessKeyId: 'mock-access-key',
          secretAccessKey: 'mock-secret-key',
          bucketName: 'mock-test-bucket',
        },
        mockS3Client
      );
    });

    it('1. successful S3-compatible upload delegates to PutObjectCommand with correct parameters', async () => {
      mockS3Client.send.mockResolvedValueOnce({});
      const testBuffer = Buffer.from('%PDF-1.4 Test PDF Content');
      await r2Provider.upload('11111111-2222-3333-4444-555555555555.pdf', testBuffer, 'application/pdf');

      expect(mockS3Client.send).toHaveBeenCalledTimes(1);
      const command = mockS3Client.send.mock.calls[0][0];
      expect(command.input.Bucket).toBe('mock-test-bucket');
      expect(command.input.Key).toBe('11111111-2222-3333-4444-555555555555.pdf');
      expect(command.input.ContentType).toBe('application/pdf');
      expect(command.input.Body).toEqual(testBuffer);
    });

    it('2. failed upload wraps internal AWS error in safe AppError (500) without exposing secret credentials', async () => {
      mockS3Client.send.mockRejectedValueOnce(
        new Error('AWS S3 error: PutObject failed with secret token: secret_abc_123')
      );
      const testBuffer = Buffer.from('%PDF-1.4 Test');

      await expect(
        r2Provider.upload('11111111-2222-3333-4444-555555555555.pdf', testBuffer, 'application/pdf')
      ).rejects.toThrow(AppError);
    });

    it('3. successful download returns readable stream, size and mimeType', async () => {
      const mockStream = Readable.from(['hello', 'world']);
      mockS3Client.send.mockResolvedValueOnce({
        Body: mockStream,
        ContentLength: 10,
        ContentType: 'application/pdf',
      });

      const result = await r2Provider.download('11111111-2222-3333-4444-555555555555.pdf');
      expect(result.size).toBe(10);
      expect(result.mimeType).toBe('application/pdf');
      expect(result.stream).toBeDefined();
    });

    it('4. download handles missing object (NoSuchKey / 404) with clean 404 NOT_FOUND AppError', async () => {
      const notFoundError = new Error('The specified key does not exist');
      (notFoundError as any).name = 'NoSuchKey';
      mockS3Client.send.mockRejectedValueOnce(notFoundError);

      await expect(
        r2Provider.download('11111111-2222-3333-4444-555555555555.pdf')
      ).rejects.toThrow('Requested file not found in storage');
    });

    it('5. download handles timeout error with 500 AppError', async () => {
      const timeoutError = new Error('Connection timed out after 30000ms');
      (timeoutError as any).name = 'TimeoutError';
      mockS3Client.send.mockRejectedValueOnce(timeoutError);

      await expect(
        r2Provider.download('11111111-2222-3333-4444-555555555555.pdf')
      ).rejects.toThrow(AppError);
    });

    it('6. download handles network interruption (ECONNRESET) with 500 AppError', async () => {
      const connError = new Error('read ECONNRESET');
      (connError as any).code = 'ECONNRESET';
      mockS3Client.send.mockRejectedValueOnce(connError);

      await expect(
        r2Provider.download('11111111-2222-3333-4444-555555555555.pdf')
      ).rejects.toThrow(AppError);
    });

    it('7. download handles invalid credentials / AccessDenied response with 500 AppError', async () => {
      const accessError = new Error('The AWS Access Key Id you provided does not exist in our records');
      (accessError as any).name = 'InvalidAccessKeyId';
      mockS3Client.send.mockRejectedValueOnce(accessError);

      await expect(
        r2Provider.download('11111111-2222-3333-4444-555555555555.pdf')
      ).rejects.toThrow(AppError);
    });

    it('8. delete succeeds and handles missing object idempotently (NoSuchKey does not throw)', async () => {
      const notFoundErr = new Error('NoSuchKey');
      (notFoundErr as any).name = 'NoSuchKey';
      mockS3Client.send.mockRejectedValueOnce(notFoundErr);

      // Must NOT throw when object was already missing
      await expect(
        r2Provider.delete('11111111-2222-3333-4444-555555555555.pdf')
      ).resolves.toBeUndefined();
    });

    it('9. delete throws 500 AppError on unexpected R2 storage failure', async () => {
      mockS3Client.send.mockRejectedValueOnce(new Error('Internal Cloudflare R2 500 error'));

      await expect(
        r2Provider.delete('11111111-2222-3333-4444-555555555555.pdf')
      ).rejects.toThrow(AppError);
    });

    it('10. exists() returns true when HeadObject succeeds and false when NotFound / NoSuchKey', async () => {
      mockS3Client.send.mockResolvedValueOnce({ ContentLength: 100 });
      const existsTrue = await r2Provider.exists('11111111-2222-3333-4444-555555555555.pdf');
      expect(existsTrue).toBe(true);

      const notFoundErr = new Error('NotFound');
      (notFoundErr as any).name = 'NotFound';
      mockS3Client.send.mockRejectedValueOnce(notFoundErr);
      const existsFalse = await r2Provider.exists('11111111-2222-3333-4444-555555555555.pdf');
      expect(existsFalse).toBe(false);
    });

    it('11. getMetadata() returns file size, mimeType, and lastModified', async () => {
      const now = new Date();
      mockS3Client.send.mockResolvedValueOnce({
        ContentLength: 2048,
        ContentType: 'application/pdf',
        LastModified: now,
      });

      const meta = await r2Provider.getMetadata('11111111-2222-3333-4444-555555555555.pdf');
      expect(meta.size).toBe(2048);
      expect(meta.mimeType).toBe('application/pdf');
      expect(meta.lastModified).toEqual(now);
    });

    it('12. getMetadata() throws 404 AppError when object is not found', async () => {
      const notFoundErr = new Error('NotFound');
      (notFoundErr as any).name = 'NotFound';
      mockS3Client.send.mockRejectedValueOnce(notFoundErr);

      await expect(
        r2Provider.getMetadata('11111111-2222-3333-4444-555555555555.pdf')
      ).rejects.toThrow('Requested file not found in storage');
    });
  });

  describe('C. LocalStorageProvider Unit Tests', () => {
    let tempDir: string;
    let localProvider: LocalStorageProvider;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peerlearn-unit-local-'));
      localProvider = new LocalStorageProvider(tempDir);
    });

    afterEach(() => {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignored
      }
    });

    it('13. uploads, checks existence, downloads, and retrieves metadata accurately', async () => {
      const testKey = '11111111-2222-3333-4444-555555555555.txt';
      const testBuffer = Buffer.from('Unit testing local storage provider');

      await localProvider.upload(testKey, testBuffer);
      expect(await localProvider.exists(testKey)).toBe(true);

      const downloadResult = await localProvider.download(testKey);
      expect(downloadResult.size).toBe(testBuffer.length);

      const meta = await localProvider.getMetadata(testKey);
      expect(meta.size).toBe(testBuffer.length);
      expect(meta.lastModified).toBeDefined();

      await localProvider.delete(testKey);
      expect(await localProvider.exists(testKey)).toBe(false);
    });

    it('14. rejects directory traversal attempts and invalid keys with 400 Bad Request', async () => {
      await expect(
        localProvider.upload('../../../etc/passwd.txt', Buffer.from('malicious'))
      ).rejects.toThrow('Invalid storage key format');

      await expect(
        localProvider.download('../../malicious.pdf')
      ).rejects.toThrow('Invalid storage key format');

      await expect(
        localProvider.getMetadata('non-uuid-key.pdf')
      ).rejects.toThrow('Invalid storage key format');
    });

    it('15. download and metadata throw 404 AppError when file does not exist on disk', async () => {
      const nonExistentKey = '99999999-8888-7777-6666-555555555555.pdf';
      await expect(
        localProvider.download(nonExistentKey)
      ).rejects.toThrow('Requested file not found in storage');

      await expect(
        localProvider.getMetadata(nonExistentKey)
      ).rejects.toThrow('Requested file not found in storage');
    });
  });

  describe('D. Storage Service Facade Unit Tests', () => {
    let mockProvider: any;

    beforeEach(() => {
      mockProvider = {
        name: 'mock',
        upload: vi.fn().mockResolvedValue(undefined),
        download: vi.fn().mockResolvedValue({
          stream: Readable.from(['test']),
          size: 4,
          mimeType: 'application/pdf',
        }),
        getDownloadUrl: vi.fn().mockResolvedValue('https://mock.storage/download?signed=1'),
        delete: vi.fn().mockResolvedValue(undefined),
        exists: vi.fn().mockResolvedValue(true),
        getMetadata: vi.fn().mockResolvedValue({ size: 4, mimeType: 'application/pdf' }),
      };
      storageService.setProvider(mockProvider);
    });

    afterEach(() => {
      storageService.resetProvider();
    });

    it('16. correctly delegates saveFile to active provider with sanitized filename and UUID key', async () => {
      const validPdfBuffer = Buffer.from('%PDF-1.4 Valid Document Content');
      const result = await storageService.saveFile(
        validPdfBuffer,
        '../../dirty/path/My Lecture #1.pdf',
        'application/pdf'
      );

      expect(result.originalName).toBe('My_Lecture__1.pdf');
      expect(result.mimeType).toBe('application/pdf');
      expect(result.sizeBytes).toBe(validPdfBuffer.length);
      expect(result.fileKey).toMatch(/^[0-9a-fA-F-]{36}\.pdf$/);

      expect(mockProvider.upload).toHaveBeenCalledTimes(1);
      expect(mockProvider.upload).toHaveBeenCalledWith(result.fileKey, validPdfBuffer, 'application/pdf');
    });

    it('17. validates safe key format across getFileStream, getDownloadUrl, deleteFile, fileExists, getMetadata', async () => {
      await expect(storageService.getFileStream('../malicious.pdf')).rejects.toThrow('Invalid storage key format');
      await expect(storageService.getDownloadUrl('invalid-key')).rejects.toThrow('Invalid storage key format');
      await expect(storageService.getFileMetadata('not-a-uuid.pdf')).rejects.toThrow('Invalid storage key format');

      // deleteFile and fileExists return cleanly/false for invalid keys without throwing
      await expect(storageService.deleteFile('../evil.pdf')).resolves.toBeUndefined();
      expect(await storageService.fileExists('../evil.pdf')).toBe(false);
    });

    it('18. getDownloadUrl clamps expiry to maximum 300 seconds', async () => {
      const safeKey = '11111111-2222-3333-4444-555555555555.pdf';
      await storageService.getDownloadUrl(safeKey, 3600); // requested 1 hour
      expect(mockProvider.getDownloadUrl).toHaveBeenCalledWith(safeKey, 300); // clamped to 300s

      await storageService.getDownloadUrl(safeKey, -50); // requested negative
      expect(mockProvider.getDownloadUrl).toHaveBeenCalledWith(safeKey, 1); // clamped to min 1s
    });

    it('19. wraps provider upload errors in AppError without leaking internal details', async () => {
      mockProvider.upload.mockRejectedValueOnce(new Error('Underlying disk full or network socket hangup'));
      const validPdfBuffer = Buffer.from('%PDF-1.4 Valid Document Content');

      await expect(
        storageService.saveFile(validPdfBuffer, 'notes.pdf', 'application/pdf')
      ).rejects.toThrow('Storage error: Failed to save file');
    });
  });
});

