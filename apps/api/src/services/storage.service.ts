import path from 'node:path';
import crypto from 'node:crypto';
import type { Readable } from 'node:stream';
import { AppError } from '../middleware/errorHandler.js';
import { HTTP_STATUS } from '@peerlume/shared';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import type {
  StorageProvider,
  UploadedFileMetadata,
  FileMetadata,
} from './storage/storage.types.js';
import {
  PERMITTED_MIME_TYPES,
  PERMITTED_EXTENSIONS,
  MAX_FILE_SIZE_BYTES,
} from './storage/storage.types.js';
import { LocalStorageProvider } from './storage/local.provider.js';
import { R2StorageProvider } from './storage/r2.provider.js';
import { validateFileSignature } from './storage/validator.js';

export {
  StorageProvider,
  UploadedFileMetadata,
  FileMetadata,
  PERMITTED_MIME_TYPES,
  PERMITTED_EXTENSIONS,
  MAX_FILE_SIZE_BYTES,
};

/**
 * Initializes the appropriate storage provider based on environment configuration.
 *
 * In production: Cloudflare R2 is strictly required. Local storage is rejected.
 * In dev/test: Local filesystem is used unless R2 credentials are provided and STORAGE_PROVIDER=r2.
 */
function createDefaultProvider(): StorageProvider {
  const providerType = env.STORAGE_PROVIDER;

  if (providerType === 'r2') {
    if (
      !env.R2_ACCOUNT_ID ||
      !env.R2_ACCESS_KEY_ID ||
      !env.R2_SECRET_ACCESS_KEY ||
      !env.R2_BUCKET_NAME
    ) {
      const errorMsg =
        'STORAGE_PROVIDER is configured as "r2", but required R2 credentials are missing or incomplete.';
      logger.error('[STORAGE] ' + errorMsg);
      throw new AppError(errorMsg, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }

    logger.info('[STORAGE] Initialized Cloudflare R2 storage provider', {
      bucket: env.R2_BUCKET_NAME,
      region: 'auto',
    });

    return new R2StorageProvider({
      accountId: env.R2_ACCOUNT_ID,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      bucketName: env.R2_BUCKET_NAME,
      publicUrl: env.R2_PUBLIC_URL,
    });
  }

  // Enforce no silent fallback to ephemeral storage in production
  if (env.NODE_ENV === 'production') {
    const errorMsg =
      'CRITICAL: Local ephemeral filesystem storage is prohibited in production. Cloudflare R2 must be configured.';
    logger.error('[STORAGE] ' + errorMsg);
    throw new AppError(errorMsg, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }

  logger.info('[STORAGE] Initialized local filesystem storage provider (dev/test only)');
  return new LocalStorageProvider();
}

let activeProvider: StorageProvider = createDefaultProvider();

export const storageService = {
  /**
   * Returns the current active storage provider
   */
  getProvider(): StorageProvider {
    return activeProvider;
  },

  /**
   * Allows injecting a custom provider (for testing or runtime switching)
   */
  setProvider(provider: StorageProvider): void {
    activeProvider = provider;
  },

  /**
   * Resets the active provider back to default configuration
   */
  resetProvider(): void {
    activeProvider = createDefaultProvider();
  },

  /**
   * Checks whether the current provider is a cloud-based provider
   */
  isCloudStorage(): boolean {
    return activeProvider.name === 'r2';
  },

  /**
   * Validates and saves an uploaded buffer securely using random cryptographic keys
   */
  async saveFile(
    buffer: Buffer,
    originalName: string,
    mimeType: string
  ): Promise<UploadedFileMetadata> {
    if (buffer.length > MAX_FILE_SIZE_BYTES) {
      throw new AppError(
        `File exceeds maximum permitted size of ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB`,
        HTTP_STATUS.BAD_REQUEST
      );
    }

    const normalizedMime = mimeType.toLowerCase().trim();
    const expectedExtension = PERMITTED_MIME_TYPES[normalizedMime];

    if (!expectedExtension) {
      throw new AppError(
        'Unsupported file format. Permitted document formats: PDF, Text, Markdown, CSV, JSON, PNG, JPEG, WebP.',
        HTTP_STATUS.BAD_REQUEST
      );
    }

    // Validate original filename extension
    const ext = path.extname(originalName).toLowerCase();
    if (ext && !PERMITTED_EXTENSIONS.has(ext)) {
      throw new AppError(
        `File extension "${ext}" is not permitted for upload`,
        HTTP_STATUS.BAD_REQUEST
      );
    }

    // Inspect file signature (magic bytes) to defend against spoofed extensions/MIME
    validateFileSignature(buffer, normalizedMime);

    // Sanitize display name (strip path navigation chars and keep only safe characters)
    const sanitizedOriginalName = path
      .basename(originalName)
      .replace(/[^a-zA-Z0-9._-]/g, '_');

    // Generate random, non-guessable storage key preventing directory traversal
    const randomKey = `${crypto.randomUUID()}${expectedExtension}`;

    try {
      await activeProvider.upload(randomKey, buffer, normalizedMime);

      logger.info('[STORAGE] File uploaded successfully', {
        fileKey: randomKey,
        originalName: sanitizedOriginalName,
        mimeType: normalizedMime,
        sizeBytes: buffer.length,
        provider: activeProvider.name,
      });

      return {
        fileKey: randomKey,
        originalName: sanitizedOriginalName,
        mimeType: normalizedMime,
        sizeBytes: buffer.length,
      };
    } catch (err: any) {
      logger.error('[STORAGE] Upload failed', {
        fileKey: randomKey,
        error: err.message,
        provider: activeProvider.name,
      });
      if (err instanceof AppError) throw err;
      throw new AppError(`Storage error: Failed to save file (${err.message})`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },

  /**
   * Retrieves a file stream or buffer securely after access authorization
   */
  async getFileStream(fileKey: string): Promise<{ stream: Readable; size: number; mimeType?: string }> {
    // Defend against path traversal: fileKey must strictly match a UUID with safe extension
    const isSafeKey = /^[0-9a-fA-F-]{36}\.[a-zA-Z0-9]+$/.test(fileKey);
    if (!isSafeKey) {
      throw new AppError('Invalid storage key format', HTTP_STATUS.BAD_REQUEST);
    }

    try {
      const result = await activeProvider.download(fileKey);
      return result;
    } catch (err: any) {
      if (err instanceof AppError) throw err;
      throw new AppError(`Storage error: Failed to retrieve file (${err.message})`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },

  /**
   * Generates a temporary, secure presigned download URL for private files
   */
  async getDownloadUrl(fileKey: string, expiresInSeconds: number = 300): Promise<string> {
    const isSafeKey = /^[0-9a-fA-F-]{36}\.[a-zA-Z0-9]+$/.test(fileKey);
    if (!isSafeKey) {
      throw new AppError('Invalid storage key format', HTTP_STATUS.BAD_REQUEST);
    }

    const clampedExpiry = Math.min(Math.max(1, Number(expiresInSeconds) || 300), 300);
    return await activeProvider.getDownloadUrl(fileKey, clampedExpiry);
  },

  /**
   * Deletes a file from storage
   */
  async deleteFile(fileKey: string): Promise<void> {
    const isSafeKey = /^[0-9a-fA-F-]{36}\.[a-zA-Z0-9]+$/.test(fileKey);
    if (!isSafeKey) return;

    try {
      await activeProvider.delete(fileKey);
      logger.info('[STORAGE] File deleted successfully', {
        fileKey,
        provider: activeProvider.name,
      });
    } catch (err: any) {
      logger.error('[STORAGE] File deletion failed', {
        fileKey,
        error: err.message,
        provider: activeProvider.name,
      });
      if (err instanceof AppError) throw err;
      throw new AppError(`Storage deletion error: ${err.message}`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },

  /**
   * Checks whether a file exists in the active storage provider
   */
  async fileExists(fileKey: string): Promise<boolean> {
    const isSafeKey = /^[0-9a-fA-F-]{36}\.[a-zA-Z0-9]+$/.test(fileKey);
    if (!isSafeKey) return false;

    return await activeProvider.exists(fileKey);
  },

  /**
   * Retrieves file metadata from the active storage provider
   */
  async getFileMetadata(fileKey: string): Promise<FileMetadata> {
    const isSafeKey = /^[0-9a-fA-F-]{36}\.[a-zA-Z0-9]+$/.test(fileKey);
    if (!isSafeKey) {
      throw new AppError('Invalid storage key format', HTTP_STATUS.BAD_REQUEST);
    }

    return await activeProvider.getMetadata(fileKey);
  },
};
