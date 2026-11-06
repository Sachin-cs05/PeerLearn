import type { Readable } from 'node:stream';

export interface UploadedFileMetadata {
  fileKey: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface FileMetadata {
  size: number;
  mimeType?: string;
  lastModified?: Date;
}

export interface StorageProvider {
  readonly name: string;
  upload(fileKey: string, buffer: Buffer, mimeType: string): Promise<void>;
  download(fileKey: string): Promise<{ stream: Readable; size: number; mimeType?: string }>;
  getDownloadUrl(fileKey: string, expiresInSeconds?: number): Promise<string>;
  delete(fileKey: string): Promise<void>;
  exists(fileKey: string): Promise<boolean>;
  getMetadata(fileKey: string): Promise<FileMetadata>;
}

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  publicUrl?: string;
}

export const PERMITTED_MIME_TYPES: Record<string, string> = {
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/json': '.json',
  'text/csv': '.csv',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

// Also permit common alternate extensions for same mime
export const PERMITTED_EXTENSIONS = new Set([
  '.pdf',
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.csv',
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
]);

export const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15 Megabytes

