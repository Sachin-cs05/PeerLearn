import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import type { StorageProvider, R2Config, FileMetadata } from './storage.types.js';
import { AppError } from '../../middleware/errorHandler.js';
import { HTTP_STATUS } from '@peerlume/shared';
import { logger } from '../../utils/logger.js';

export class R2StorageProvider implements StorageProvider {
  readonly name = 'r2';
  private client: S3Client;
  private bucketName: string;
  private publicUrl?: string;

  constructor(config: R2Config, customClient?: S3Client) {
    this.bucketName = config.bucketName;
    this.publicUrl = config.publicUrl;

    if (customClient) {
      this.client = customClient;
    } else {
      const endpoint = `https://${config.accountId}.r2.cloudflarestorage.com`;
      this.client = new S3Client({
        region: 'auto',
        endpoint,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
      });
    }
  }

  getClient(): S3Client {
    return this.client;
  }

  getBucketName(): string {
    return this.bucketName;
  }

  async upload(fileKey: string, buffer: Buffer, mimeType: string): Promise<void> {
    try {
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: fileKey,
        Body: buffer,
        ContentType: mimeType,
      });

      await this.client.send(command);
    } catch (err: any) {
      logger.error('[R2_STORAGE] Failed to upload object to R2', {
        fileKey,
        bucket: this.bucketName,
        error: err.message,
      });
      throw new AppError(`Storage error: Failed to save file (${err.message})`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }

  async download(fileKey: string): Promise<{ stream: Readable; size: number; mimeType?: string }> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: fileKey,
      });

      const response = await this.client.send(command);

      if (!response.Body) {
        throw new AppError('Requested file content is empty or unavailable', HTTP_STATUS.NOT_FOUND);
      }

      return {
        stream: response.Body as unknown as Readable,
        size: response.ContentLength ?? 0,
        mimeType: response.ContentType,
      };
    } catch (err: any) {
      if (err.name === 'NoSuchKey' || err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        throw new AppError('Requested file not found in storage', HTTP_STATUS.NOT_FOUND);
      }
      logger.error('[R2_STORAGE] Failed to download object from R2', {
        fileKey,
        bucket: this.bucketName,
        error: err.message,
      });
      throw new AppError(`Storage error: Failed to retrieve file (${err.message})`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }

  async getDownloadUrl(fileKey: string, expiresInSeconds: number = 300): Promise<string> {
    const clampedExpiry = Math.min(Math.max(1, Number(expiresInSeconds) || 300), 300);
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: fileKey,
      });

      return await getSignedUrl(this.client, command, { expiresIn: clampedExpiry });
    } catch (err: any) {
      logger.error('[R2_STORAGE] Failed to generate presigned download URL', {
        fileKey,
        error: err.message,
      });
      throw new AppError('Failed to generate secure download link', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }

  async delete(fileKey: string): Promise<void> {
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: fileKey,
      });

      await this.client.send(command);
    } catch (err: any) {
      if (err.name === 'NoSuchKey' || err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        // Missing object in storage is safe to ignore (idempotent deletion)
        return;
      }
      logger.error('[R2_STORAGE] Failed to delete object from R2', {
        fileKey,
        error: err.message,
      });
      throw new AppError(`Storage deletion error: ${err.message}`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }

  async exists(fileKey: string): Promise<boolean> {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: fileKey,
      });

      await this.client.send(command);
      return true;
    } catch (err: any) {
      if (err.name === 'NotFound' || err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
        return false;
      }
      logger.error('[R2_STORAGE] HeadObject error in exists check', {
        fileKey,
        error: err.message,
      });
      return false;
    }
  }

  async getMetadata(fileKey: string): Promise<FileMetadata> {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: fileKey,
      });

      const response = await this.client.send(command);
      return {
        size: response.ContentLength ?? 0,
        mimeType: response.ContentType,
        lastModified: response.LastModified,
      };
    } catch (err: any) {
      if (err.name === 'NotFound' || err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
        throw new AppError('Requested file not found in storage', HTTP_STATUS.NOT_FOUND);
      }
      throw new AppError(`Storage metadata error: ${err.message}`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
}

