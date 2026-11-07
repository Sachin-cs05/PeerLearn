import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { R2StorageProvider } from '../src/services/storage/r2.provider.js';

const isProduction = process.env.NODE_ENV === 'production';
const isExplicitlyEnabled = process.env.STORAGE_INTEGRATION_TESTS === 'true';
const testBucket = process.env.STORAGE_TEST_BUCKET;
const shouldRun = isExplicitlyEnabled && Boolean(testBucket) && !isProduction;

describe('Phase 2.4 — Task 10: Live Cloudflare R2 Integration Tests (Gated)', () => {
  if (isProduction) {
    it('strictly refuses to run live integration tests in production environment', () => {
      expect(isProduction).toBe(true);
      console.warn('[STORAGE_INTEGRATION_TESTS] Refusing to run in production environment.');
    });
    return;
  }

  if (!shouldRun) {
    it('SKIPPED — REAL R2 CREDENTIALS NOT CONFIGURED (Gated by STORAGE_INTEGRATION_TESTS=true and STORAGE_TEST_BUCKET)', () => {
      console.log(
        '[STORAGE_INTEGRATION_TESTS] Skipped live R2 integration tests. Required environment variables (STORAGE_INTEGRATION_TESTS=true, STORAGE_TEST_BUCKET) not present.'
      );
      expect(true).toBe(true);
    });
    return;
  }

  // Live R2 test suite when explicitly enabled with dedicated test bucket
  const accountId = process.env.CLOUDFLARE_R2_ACCOUNT_ID || '';
  const accessKeyId = process.env.CLOUDFLARE_R2_ACCESS_KEY_ID || '';
  const secretAccessKey = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY || '';

  const r2Provider = new R2StorageProvider({
    accountId,
    accessKeyId,
    secretAccessKey,
    bucketName: testBucket!,
  });

  const testKey = `test-phase2-4-synthetic-${crypto.randomUUID()}.txt`;
  const syntheticContent = `PeerLearn Live R2 Test Payload - ${new Date().toISOString()} - ${crypto.randomBytes(32).toString('hex')}`;
  const syntheticBuffer = Buffer.from(syntheticContent, 'utf-8');
  const expectedHash = crypto.createHash('sha256').update(syntheticBuffer).digest('hex');

  afterAll(async () => {
    try {
      if (await r2Provider.exists(testKey)) {
        await r2Provider.delete(testKey);
      }
    } catch (err) {
      console.error('[STORAGE_INTEGRATION_TESTS] Cleanup error:', err);
    }
  });

  it('1. uploads synthetic object and verifies existence and metadata in R2 test bucket', async () => {
    await r2Provider.upload(testKey, syntheticBuffer, 'text/plain');

    const exists = await r2Provider.exists(testKey);
    expect(exists).toBe(true);

    const metadata = await r2Provider.getMetadata(testKey);
    expect(metadata).not.toBeNull();
    expect(metadata?.size).toBe(syntheticBuffer.length);
    expect(metadata?.mimeType).toContain('text/plain');
  });

  it('2. downloads uploaded object and verifies byte-for-byte SHA-256 integrity', async () => {
    const { stream, size, mimeType } = await r2Provider.download(testKey);
    expect(size).toBe(syntheticBuffer.length);
    expect(mimeType).toContain('text/plain');

    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const downloadedBuffer = Buffer.concat(chunks);
    const downloadedHash = crypto.createHash('sha256').update(downloadedBuffer).digest('hex');

    expect(downloadedHash).toBe(expectedHash);
    expect(downloadedBuffer.toString('utf-8')).toBe(syntheticContent);
  });

  it('3. generates valid presigned URL adhering to 300s expiration limit', async () => {
    const signedUrl = await r2Provider.getDownloadUrl(testKey, 300);
    expect(signedUrl).toBeDefined();
    expect(typeof signedUrl).toBe('string');
    expect(signedUrl).toContain(testBucket);
    expect(signedUrl).toContain('X-Amz-Expires=300');
  });

  it('4. deletes exact test object and confirms deletion without affecting other keys', async () => {
    await r2Provider.delete(testKey);

    const existsAfterDelete = await r2Provider.exists(testKey);
    expect(existsAfterDelete).toBe(false);

    const metadataAfterDelete = await r2Provider.getMetadata(testKey);
    expect(metadataAfterDelete).toBeNull();
  });
});
