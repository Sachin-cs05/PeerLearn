import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StorageInventoryService } from '../src/services/storage/migration/inventory.service.js';
import { StorageMigrationService } from '../src/services/storage/migration/migration.service.js';
import type { StorageProvider } from '../src/services/storage/storage.types.js';

describe('Phase 2.3: Existing File Migration to Cloudflare R2 (Inventory & Dry-Run)', () => {
  let testUploadsDir: string;
  let inventoryService: StorageInventoryService;
  let migrationService: StorageMigrationService;

  beforeEach(() => {
    vi.restoreAllMocks();
    testUploadsDir = path.join(os.tmpdir(), `peerlearn-test-uploads-${Date.now()}`);
    fs.mkdirSync(testUploadsDir, { recursive: true });

    inventoryService = new StorageInventoryService();
    migrationService = new StorageMigrationService();
  });

  afterEach(() => {
    try {
      if (fs.existsSync(testUploadsDir)) {
        fs.rmSync(testUploadsDir, { recursive: true, force: true });
      }
    } catch {
      // Cleanup
    }
  });

  // ===========================================================================
  // 1. Inventory Discovery & File Mapping
  // ===========================================================================
  describe('1. Inventory Discovery & File Mapping', () => {
    it('discovers matching local files and correctly maps them to DB LearningResource records', async () => {
      const validKey = '11111111-2222-3333-4444-555555555555.pdf';
      const fileBuffer = Buffer.from('%PDF-1.4 Valid lecture notes content');
      fs.writeFileSync(path.join(testUploadsDir, validKey), fileBuffer);

      const mockPrisma = {
        learningResource: {
          findMany: vi.fn().mockResolvedValueOnce([
            {
              id: 'res-1',
              fileKey: validKey,
              fileName: 'lecture_notes.pdf',
              fileSize: fileBuffer.length,
              mimeType: 'application/pdf',
              title: 'Lecture Notes',
              isPrivate: true,
              createdAt: new Date(),
            },
          ]),
        },
      };

      const report = await inventoryService.scanInventory({
        legacyDirs: [testUploadsDir],
        prismaClient: mockPrisma,
      });

      expect(report.totalDbRecords).toBe(1);
      expect(report.totalLocalFiles).toBe(1);
      expect(report.eligibleFiles).toBe(1);
      expect(report.missingLocalFiles).toBe(0);
      expect(report.orphanLocalFiles).toBe(0);

      const item = report.items.find((i) => i.fileKey === validKey);
      expect(item).toBeDefined();
      expect(item?.status).toBe('ELIGIBLE');
      expect(item?.resourceId).toBe('res-1');
      expect(item?.sha256).toBe(inventoryService.computeSha256(fileBuffer));
      expect(report.totalEligibleSizeBytes).toBe(fileBuffer.length);
    });

    it('identifies missing local files when DB record exists but physical file does not', async () => {
      const missingKey = '22222222-3333-4444-5555-666666666666.pdf';
      // Notice: We do NOT create the file in testUploadsDir

      const mockPrisma = {
        learningResource: {
          findMany: vi.fn().mockResolvedValueOnce([
            {
              id: 'res-missing',
              fileKey: missingKey,
              fileName: 'lost_doc.pdf',
              fileSize: 1024,
              mimeType: 'application/pdf',
              title: 'Lost Document',
              isPrivate: false,
              createdAt: new Date(),
            },
          ]),
        },
      };

      const report = await inventoryService.scanInventory({
        legacyDirs: [testUploadsDir],
        prismaClient: mockPrisma,
      });

      expect(report.totalDbRecords).toBe(1);
      expect(report.totalLocalFiles).toBe(0);
      expect(report.eligibleFiles).toBe(0);
      expect(report.missingLocalFiles).toBe(1);

      const item = report.items.find((i) => i.fileKey === missingKey);
      expect(item?.status).toBe('MISSING_ON_DISK');
      expect(item?.localPath).toBeNull();
      expect(report.warnings.some((w) => w.includes('ephemeral'))).toBe(true);
    });

    it('identifies orphan local files when physical file exists but has no DB record', async () => {
      const orphanKey = '33333333-4444-5555-6666-777777777777.pdf';
      fs.writeFileSync(path.join(testUploadsDir, orphanKey), Buffer.from('%PDF-1.4 Orphan buffer'));

      const mockPrisma = {
        learningResource: {
          findMany: vi.fn().mockResolvedValueOnce([]), // Zero DB records
        },
      };

      const report = await inventoryService.scanInventory({
        legacyDirs: [testUploadsDir],
        prismaClient: mockPrisma,
      });

      expect(report.totalDbRecords).toBe(0);
      expect(report.totalLocalFiles).toBe(1);
      expect(report.orphanLocalFiles).toBe(1);

      const item = report.items.find((i) => i.fileKey === orphanKey);
      expect(item?.status).toBe('ORPHAN_ON_DISK');
      expect(item?.resourceId).toBeNull();
    });

    it('detects duplicate files by SHA-256 hash across different records', async () => {
      const key1 = '44444444-5555-6666-7777-888888888888.pdf';
      const key2 = '55555555-6666-7777-8888-999999999999.pdf';
      const identicalBuffer = Buffer.from('%PDF-1.4 Exactly identical syllabus document');

      fs.writeFileSync(path.join(testUploadsDir, key1), identicalBuffer);
      fs.writeFileSync(path.join(testUploadsDir, key2), identicalBuffer);

      const mockPrisma = {
        learningResource: {
          findMany: vi.fn().mockResolvedValueOnce([
            { id: 'res-orig', fileKey: key1, fileName: 'syllabus1.pdf', mimeType: 'application/pdf', fileSize: identicalBuffer.length },
            { id: 'res-dup', fileKey: key2, fileName: 'syllabus2.pdf', mimeType: 'application/pdf', fileSize: identicalBuffer.length },
          ]),
        },
      };

      const report = await inventoryService.scanInventory({
        legacyDirs: [testUploadsDir],
        prismaClient: mockPrisma,
      });

      expect(report.totalLocalFiles).toBe(2);
      expect(report.duplicateFiles).toBe(1);

      const dupItem = report.items.find((i) => i.fileKey === key2);
      expect(dupItem?.status).toBe('DUPLICATE_CONTENT');
      expect(dupItem?.duplicateOf).toBe(key1);
    });

    it('identifies unsupported file formats or invalid magic bytes', async () => {
      const badKey = '66666666-7777-8888-9999-000000000000.pdf';
      // Writing invalid binary data with fake PDF extension
      fs.writeFileSync(path.join(testUploadsDir, badKey), Buffer.from('NOT_A_PDF_CORRUPT_BYTES'));

      const mockPrisma = {
        learningResource: {
          findMany: vi.fn().mockResolvedValueOnce([
            { id: 'res-bad', fileKey: badKey, fileName: 'corrupt.pdf', mimeType: 'application/pdf', fileSize: 22 },
          ]),
        },
      };

      const report = await inventoryService.scanInventory({
        legacyDirs: [testUploadsDir],
        prismaClient: mockPrisma,
      });

      expect(report.unsupportedFiles).toBe(1);
      const badItem = report.items.find((i) => i.fileKey === badKey);
      expect(badItem?.status).toBe('UNSUPPORTED_FORMAT');
    });

    it('identifies already-migrated files verified to exist in Cloudflare R2', async () => {
      const migratedKey = '77777777-8888-9999-0000-111111111111.pdf';
      const fileBuffer = Buffer.from('%PDF-1.4 Migrated content');
      fs.writeFileSync(path.join(testUploadsDir, migratedKey), fileBuffer);

      const mockPrisma = {
        learningResource: {
          findMany: vi.fn().mockResolvedValueOnce([
            { id: 'res-migrated', fileKey: migratedKey, fileName: 'migrated.pdf', mimeType: 'application/pdf', fileSize: fileBuffer.length },
          ]),
        },
      };

      const mockR2Provider: Partial<StorageProvider> = {
        name: 'r2',
        exists: vi.fn().mockResolvedValue(true), // Already in R2
      };

      const report = await inventoryService.scanInventory({
        legacyDirs: [testUploadsDir],
        prismaClient: mockPrisma,
        r2Provider: mockR2Provider as StorageProvider,
      });

      expect(report.alreadyMigratedFiles).toBe(1);
      expect(report.eligibleFiles).toBe(0);

      const item = report.items.find((i) => i.fileKey === migratedKey);
      expect(item?.status).toBe('ALREADY_MIGRATED');
    });
  });

  // ===========================================================================
  // 2. Dry-Run Execution & Zero Side-Effects Guarantee
  // ===========================================================================
  describe('2. Dry-Run Execution & Zero Side-Effects Guarantee', () => {
    it('executes dry-run without modifying database or uploading to R2', async () => {
      const validKey = '88888888-9999-0000-1111-222222222222.pdf';
      const fileBuffer = Buffer.from('%PDF-1.4 Dry-run verified content');
      const filePath = path.join(testUploadsDir, validKey);
      fs.writeFileSync(filePath, fileBuffer);

      const updateSpy = vi.fn();
      const mockPrisma = {
        learningResource: {
          findMany: vi.fn().mockResolvedValueOnce([
            { id: 'res-dry', fileKey: validKey, fileName: 'dry.pdf', mimeType: 'application/pdf', fileSize: fileBuffer.length },
          ]),
          update: updateSpy,
        },
      };

      const reportFilePath = path.join(testUploadsDir, 'test-dry-run-report.md');

      vi.spyOn(inventoryService, 'getLegacyDirectories').mockReturnValue([testUploadsDir]);
      vi.spyOn(inventoryService, 'scanInventory').mockImplementationOnce(() =>
        new StorageInventoryService().scanInventory({
          legacyDirs: [testUploadsDir],
          prismaClient: mockPrisma,
        })
      );

      const result = await migrationService.runMigration({
        dryRun: true,
        legacyDirs: [testUploadsDir],
        reportPath: reportFilePath,
        prismaClient: mockPrisma,
      });

      expect(result.dryRun).toBe(true);
      expect(result.migratedCount).toBe(0); // Zero files migrated
      expect(result.inventory.eligibleFiles).toBe(1);

      // Verify ZERO database updates occurred
      expect(updateSpy).not.toHaveBeenCalled();

      // Verify original local file was untouched
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath).equals(fileBuffer)).toBe(true);

      // Verify markdown report was generated and contains expected sections
      expect(fs.existsSync(reportFilePath)).toBe(true);
      const markdown = fs.readFileSync(reportFilePath, 'utf-8');
      expect(markdown).toContain('Phase 2.3 — Storage Migration to Cloudflare R2');
      expect(markdown).toContain('DRY-RUN EXECUTION');
      expect(markdown).toContain('Total DB File Records');
      expect(markdown).toContain('Safety & Operational Invariants');
    });
  });
});
