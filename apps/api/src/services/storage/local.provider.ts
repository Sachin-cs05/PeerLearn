import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { StorageProvider, FileMetadata } from './storage.types.js';
import { AppError } from '../../middleware/errorHandler.js';
import { HTTP_STATUS } from '@peerlume/shared';

export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local';
  private uploadsDir: string;

  constructor(customUploadsDir?: string) {
    this.uploadsDir = customUploadsDir || path.resolve(process.cwd(), 'uploads');
    if (!fs.existsSync(this.uploadsDir)) {
      try {
        fs.mkdirSync(this.uploadsDir, { recursive: true });
      } catch {
        // Directory handled during write
      }
    }
  }

  private getFilePath(fileKey: string): string {
    const isSafeKey = /^[0-9a-fA-F-]{36}\.[a-zA-Z0-9]+$/.test(fileKey);
    if (!isSafeKey) {
      throw new AppError('Invalid storage key format', HTTP_STATUS.BAD_REQUEST);
    }
    const resolvedPath = path.resolve(this.uploadsDir, fileKey);
    if (!resolvedPath.startsWith(this.uploadsDir)) {
      throw new AppError('Path traversal attempt detected', HTTP_STATUS.BAD_REQUEST);
    }
    return resolvedPath;
  }

  async upload(fileKey: string, buffer: Buffer): Promise<void> {
    const filePath = this.getFilePath(fileKey);
    try {
      await fs.promises.writeFile(filePath, buffer);
    } catch (err: any) {
      throw new AppError(`Local storage write error: ${err.message}`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }

  async download(fileKey: string): Promise<{ stream: Readable; size: number; mimeType?: string }> {
    const filePath = this.getFilePath(fileKey);
    if (!fs.existsSync(filePath)) {
      throw new AppError('Requested file not found in storage', HTTP_STATUS.NOT_FOUND);
    }

    const stat = await fs.promises.stat(filePath);
    const stream = fs.createReadStream(filePath);
    return { stream, size: stat.size };
  }

  async getDownloadUrl(fileKey: string): Promise<string> {
    // For local development, presigned URLs are not available; return relative API download path
    return `/api/resources/${encodeURIComponent(fileKey)}/download`;
  }

  async delete(fileKey: string): Promise<void> {
    try {
      const filePath = this.getFilePath(fileKey);
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
      }
    } catch {
      // Best-effort cleanup
    }
  }

  async exists(fileKey: string): Promise<boolean> {
    try {
      const filePath = this.getFilePath(fileKey);
      return fs.existsSync(filePath);
    } catch {
      return false;
    }
  }

  async getMetadata(fileKey: string): Promise<FileMetadata> {
    const filePath = this.getFilePath(fileKey);
    if (!fs.existsSync(filePath)) {
      throw new AppError('Requested file not found in storage', HTTP_STATUS.NOT_FOUND);
    }
    const stat = await fs.promises.stat(filePath);
    return {
      size: stat.size,
      lastModified: stat.mtime,
    };
  }
}

