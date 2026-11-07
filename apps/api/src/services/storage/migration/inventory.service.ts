import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { prisma as defaultPrisma } from '../../../config/prisma.js';
import { logger } from '../../../utils/logger.js';
import {
  PERMITTED_EXTENSIONS,
  PERMITTED_MIME_TYPES,
  type StorageProvider,
} from '../storage.types.js';
import { validateFileSignature } from '../validator.js';
import type {
  InventoryItem,
  StorageInventoryReport,
} from './migration.types.js';

export interface ScanInventoryOptions {
  legacyDirs?: string[];
  prismaClient?: any;
  r2Provider?: StorageProvider;
}

export class StorageInventoryService {
  /**
   * Discovers and deduplicates legacy upload directories
   */
  public getLegacyDirectories(customDirs?: string[]): string[] {
    const candidateDirs = new Set<string>();

    if (customDirs && customDirs.length > 0) {
      for (const d of customDirs) {
        candidateDirs.add(path.resolve(d));
      }
    } else {
      if (process.env.LEGACY_UPLOADS_DIR) {
        candidateDirs.add(path.resolve(process.env.LEGACY_UPLOADS_DIR));
      }

      // Default project legacy paths
      candidateDirs.add(path.resolve(process.cwd(), 'uploads'));
      candidateDirs.add(path.resolve(process.cwd(), 'apps/api/uploads'));
      candidateDirs.add(path.resolve(process.cwd(), '../api/uploads'));
      candidateDirs.add(path.resolve(process.cwd(), '../../uploads'));
    }

    const existingDirs: string[] = [];
    for (const dir of candidateDirs) {
      try {
        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
          existingDirs.push(dir);
        }
      } catch {
        // Ignored
      }
    }

    return existingDirs;
  }

  /**
   * Computes SHA-256 hash of a file buffer
   */
  public computeSha256(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  /**
   * Performs read-only inventory scan mapping database records and local storage files
   */
  async scanInventory(options?: ScanInventoryOptions): Promise<StorageInventoryReport> {
    const prismaClient = options?.prismaClient || defaultPrisma;
    const legacyDirs = this.getLegacyDirectories(options?.legacyDirs);
    const r2Provider = options?.r2Provider;

    logger.info('[STORAGE_INVENTORY] Starting read-only storage inventory scan', {
      legacyDirs,
    });

    // 1. Fetch all LearningResource records with a fileKey from PostgreSQL
    let dbResources: Array<{
      id: string;
      fileKey: string | null;
      fileName: string | null;
      fileSize: number | null;
      mimeType: string | null;
      title: string;
      isPrivate: boolean;
      createdAt: Date;
    }> = [];

    try {
      if (prismaClient.learningResource) {
        dbResources = await prismaClient.learningResource.findMany({
          where: {
            fileKey: { not: null },
          },
          select: {
            id: true,
            fileKey: true,
            fileName: true,
            fileSize: true,
            mimeType: true,
            title: true,
            isPrivate: true,
            createdAt: true,
          },
        });
      }
    } catch (dbErr: any) {
      logger.warn('[STORAGE_INVENTORY] Could not query database LearningResource records', {
        error: dbErr.message,
      });
    }

    // 2. Discover all local files on disk
    interface LocalFileInfo {
      fileName: string;
      fullPath: string;
      sizeBytes: number;
      sha256: string;
      buffer: Buffer;
    }

    const localFilesMap = new Map<string, LocalFileInfo>();

    for (const dir of legacyDirs) {
      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && !entry.name.startsWith('.')) {
            const fullPath = path.join(dir, entry.name);
            try {
              const buffer = await fs.promises.readFile(fullPath);
              const sha256 = this.computeSha256(buffer);
              localFilesMap.set(entry.name, {
                fileName: entry.name,
                fullPath,
                sizeBytes: buffer.length,
                sha256,
                buffer,
              });
            } catch (readErr: any) {
              logger.warn('[STORAGE_INVENTORY] Failed to read local file', {
                path: fullPath,
                error: readErr.message,
              });
            }
          }
        }
      } catch (err: any) {
        logger.warn('[STORAGE_INVENTORY] Failed to scan directory', {
          dir,
          error: err.message,
        });
      }
    }

    const items: InventoryItem[] = [];
    const matchedLocalFileNames = new Set<string>();
    const shaMap = new Map<string, string>(); // sha256 -> first fileKey
    let duplicateCount = 0;
    let totalEligibleSize = 0;

    // 3. Evaluate each Database Record against Local Storage & R2
    for (const dbRes of dbResources) {
      const fileKey = dbRes.fileKey!;
      const localFile = localFilesMap.get(fileKey);

      if (localFile) {
        matchedLocalFileNames.add(fileKey);

        // Check if format is supported
        const ext = path.extname(fileKey).toLowerCase();
        let isSupported = PERMITTED_EXTENSIONS.has(ext);

        if (isSupported && dbRes.mimeType) {
          try {
            validateFileSignature(localFile.buffer, dbRes.mimeType);
          } catch {
            isSupported = false;
          }
        }

        if (!isSupported) {
          items.push({
            fileKey,
            resourceId: dbRes.id,
            fileName: dbRes.fileName || fileKey,
            mimeType: dbRes.mimeType,
            sizeBytes: localFile.sizeBytes,
            localPath: localFile.fullPath,
            sha256: localFile.sha256,
            status: 'UNSUPPORTED_FORMAT',
            reason: `File format or signature validation failed for extension ${ext}`,
          });
          continue;
        }

        // Check if duplicate content
        let duplicateOf: string | undefined;
        if (shaMap.has(localFile.sha256)) {
          duplicateOf = shaMap.get(localFile.sha256);
          duplicateCount += 1;
        } else {
          shaMap.set(localFile.sha256, fileKey);
        }

        // Check if already in R2
        let alreadyInR2 = false;
        if (r2Provider) {
          try {
            alreadyInR2 = await r2Provider.exists(fileKey);
          } catch {
            alreadyInR2 = false;
          }
        }

        if (alreadyInR2) {
          items.push({
            fileKey,
            resourceId: dbRes.id,
            fileName: dbRes.fileName || fileKey,
            mimeType: dbRes.mimeType,
            sizeBytes: localFile.sizeBytes,
            localPath: localFile.fullPath,
            sha256: localFile.sha256,
            status: 'ALREADY_MIGRATED',
            duplicateOf,
            reason: 'Object already exists and is verified in Cloudflare R2 storage',
          });
        } else {
          totalEligibleSize += localFile.sizeBytes;
          items.push({
            fileKey,
            resourceId: dbRes.id,
            fileName: dbRes.fileName || fileKey,
            mimeType: dbRes.mimeType,
            sizeBytes: localFile.sizeBytes,
            localPath: localFile.fullPath,
            sha256: localFile.sha256,
            status: duplicateOf ? 'DUPLICATE_CONTENT' : 'ELIGIBLE',
            duplicateOf,
          });
        }
      } else {
        // Referenced in database but missing from local disk
        items.push({
          fileKey,
          resourceId: dbRes.id,
          fileName: dbRes.fileName || fileKey,
          mimeType: dbRes.mimeType,
          sizeBytes: dbRes.fileSize || 0,
          localPath: null,
          sha256: null,
          status: 'MISSING_ON_DISK',
          reason: 'Referenced in PostgreSQL database but missing on disk (Render ephemeral container restart or missing upload)',
        });
      }
    }

    // 4. Identify Orphan Local Files (files on disk with no DB record)
    for (const [fileName, fileInfo] of localFilesMap.entries()) {
      if (!matchedLocalFileNames.has(fileName)) {
        let duplicateOf: string | undefined;
        if (shaMap.has(fileInfo.sha256)) {
          duplicateOf = shaMap.get(fileInfo.sha256);
          duplicateCount += 1;
        } else {
          shaMap.set(fileInfo.sha256, fileName);
        }

        items.push({
          fileKey: fileName,
          resourceId: null,
          fileName,
          mimeType: null,
          sizeBytes: fileInfo.sizeBytes,
          localPath: fileInfo.fullPath,
          sha256: fileInfo.sha256,
          status: 'ORPHAN_ON_DISK',
          duplicateOf,
          reason: 'File exists on local filesystem but is not referenced by any LearningResource record in database',
        });
      }
    }

    // 5. Aggregate metrics
    const eligibleFiles = items.filter((i) => i.status === 'ELIGIBLE').length;
    const missingLocalFiles = items.filter((i) => i.status === 'MISSING_ON_DISK').length;
    const orphanLocalFiles = items.filter((i) => i.status === 'ORPHAN_ON_DISK').length;
    const alreadyMigratedFiles = items.filter((i) => i.status === 'ALREADY_MIGRATED').length;
    const duplicateFiles = items.filter((i) => i.status === 'DUPLICATE_CONTENT').length;
    const unsupportedFiles = items.filter((i) => i.status === 'UNSUPPORTED_FORMAT').length;

    // 6. Generate Warnings & Recommended Actions
    const warnings: string[] = [];
    const recommendedActions: string[] = [];

    if (missingLocalFiles > 0) {
      warnings.push(
        `${missingLocalFiles} database record(s) reference fileKey(s) not found on local disk. Render's root container filesystem is ephemeral; unmounted files do not survive container restarts.`
      );
      recommendedActions.push(
        'Retain missing record metadata for auditing. Notify authors or mark resources for re-upload if original files cannot be recovered.'
      );
    }

    if (orphanLocalFiles > 0) {
      warnings.push(
        `${orphanLocalFiles} local file(s) exist without database associations.`
      );
      recommendedActions.push(
        'Archive orphan files into a quarantine bucket or directory; do not automatically delete them.'
      );
    }

    if (duplicateCount > 0) {
      warnings.push(
        `${duplicateCount} duplicate file content instance(s) detected via SHA-256 matching.`
      );
      recommendedActions.push(
        'Migration engine can map duplicate records to unique R2 object keys to maintain strict database referential integrity.'
      );
    }

    if (unsupportedFiles > 0) {
      warnings.push(
        `${unsupportedFiles} file(s) failed extension or file signature validation.`
      );
      recommendedActions.push(
        'Skip unsupported files during migration and flag them for manual administrator review.'
      );
    }

    if (eligibleFiles === 0 && missingLocalFiles === 0 && dbResources.length === 0) {
      recommendedActions.push(
        'Database has zero uploaded files; system is ready for fresh uploads directly to Cloudflare R2.'
      );
    } else if (eligibleFiles > 0) {
      recommendedActions.push(
        `Execute dry-run migration review for ${eligibleFiles} eligible file(s) (${Math.round(totalEligibleSize / 1024)} KB) prior to live execution.`
      );
    }

    return {
      scannedAt: new Date(),
      legacyDirectories: legacyDirs,
      totalDbRecords: dbResources.length,
      totalLocalFiles: localFilesMap.size,
      eligibleFiles,
      missingLocalFiles,
      orphanLocalFiles,
      alreadyMigratedFiles,
      duplicateFiles,
      unsupportedFiles,
      totalEligibleSizeBytes: totalEligibleSize,
      items,
      warnings,
      recommendedActions,
    };
  }
}

export const storageInventoryService = new StorageInventoryService();

