import { AppError } from '../../middleware/errorHandler.js';
import { HTTP_STATUS } from '@peerlume/shared';

/**
 * Validates file magic bytes (file signature) against the declared MIME type.
 * Ensures uploaded binary files match their claimed format and prevents
 * executable binaries from masquerading as text documents or images.
 */
export function validateFileSignature(buffer: Buffer, mimeType: string): void {
  const normalizedMime = mimeType.toLowerCase().trim();

  // 1. PDF: Must begin with %PDF- (0x25, 0x50, 0x44, 0x46, 0x2D)
  if (normalizedMime === 'application/pdf') {
    if (buffer.length < 5) {
      throw new AppError('Invalid PDF file: file is truncated or empty', HTTP_STATUS.BAD_REQUEST);
    }
    const header = buffer.subarray(0, 5).toString('ascii');
    if (!header.startsWith('%PDF-')) {
      throw new AppError(
        'File signature mismatch: File content does not match a valid PDF format',
        HTTP_STATUS.BAD_REQUEST
      );
    }
    return;
  }

  // 2. PNG: Must begin with \x89PNG\r\n\x1a\n (0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
  if (normalizedMime === 'image/png') {
    if (buffer.length < 8) {
      throw new AppError('Invalid PNG file: file is truncated or empty', HTTP_STATUS.BAD_REQUEST);
    }
    const isPng =
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a;
    if (!isPng) {
      throw new AppError(
        'File signature mismatch: File content does not match a valid PNG image format',
        HTTP_STATUS.BAD_REQUEST
      );
    }
    return;
  }

  // 3. JPEG: Must begin with 0xFF, 0xD8, 0xFF
  if (normalizedMime === 'image/jpeg') {
    if (buffer.length < 3) {
      throw new AppError('Invalid JPEG file: file is truncated or empty', HTTP_STATUS.BAD_REQUEST);
    }
    const isJpg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    if (!isJpg) {
      throw new AppError(
        'File signature mismatch: File content does not match a valid JPEG image format',
        HTTP_STATUS.BAD_REQUEST
      );
    }
    return;
  }

  // 4. WebP: Starts with RIFF at offset 0 and WEBP at offset 8
  if (normalizedMime === 'image/webp') {
    if (buffer.length < 12) {
      throw new AppError('Invalid WebP file: file is truncated or empty', HTTP_STATUS.BAD_REQUEST);
    }
    const isRiff = buffer.subarray(0, 4).toString('ascii') === 'RIFF';
    const isWebp = buffer.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!isRiff || !isWebp) {
      throw new AppError(
        'File signature mismatch: File content does not match a valid WebP image format',
        HTTP_STATUS.BAD_REQUEST
      );
    }
    return;
  }

  // 5. Text-based formats (text/plain, text/markdown, text/csv, application/json)
  if (
    normalizedMime === 'text/plain' ||
    normalizedMime === 'text/markdown' ||
    normalizedMime === 'text/csv' ||
    normalizedMime === 'application/json'
  ) {
    // Check for dangerous binary executable signatures masquerading as text
    if (buffer.length >= 2) {
      // Windows DOS/PE executable ('MZ')
      if (buffer[0] === 0x4d && buffer[1] === 0x5a) {
        throw new AppError(
          'Security violation: Executable binary detected masquerading as text document',
          HTTP_STATUS.BAD_REQUEST
        );
      }
    }
    if (buffer.length >= 4) {
      // Linux ELF executable (\x7fELF)
      if (buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) {
        throw new AppError(
          'Security violation: Executable binary detected masquerading as text document',
          HTTP_STATUS.BAD_REQUEST
        );
      }
      // Java class / Mach-O binary
      if (
        (buffer[0] === 0xca && buffer[1] === 0xfe && buffer[2] === 0xba && buffer[3] === 0xbe) ||
        (buffer[0] === 0xfe && buffer[1] === 0xed && buffer[2] === 0xfa && buffer[3] === 0xce) ||
        (buffer[0] === 0xcf && buffer[1] === 0xfa && buffer[2] === 0xed && buffer[3] === 0xfe)
      ) {
        throw new AppError(
          'Security violation: Executable binary detected masquerading as text document',
          HTTP_STATUS.BAD_REQUEST
        );
      }
      // Zip / Jar / Archive (PK\x03\x04)
      if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
        throw new AppError(
          'Security violation: Compressed archive binary detected masquerading as text document',
          HTTP_STATUS.BAD_REQUEST
        );
      }
    }

    // Check for null bytes in the first 1KB of text files (indicator of binary payload)
    const inspectLength = Math.min(buffer.length, 1024);
    for (let i = 0; i < inspectLength; i++) {
      if (buffer[i] === 0x00) {
        throw new AppError(
          'Security violation: Binary content or null bytes detected in text document',
          HTTP_STATUS.BAD_REQUEST
        );
      }
    }

    // For application/json, verify valid JSON syntax if under 5MB
    if (normalizedMime === 'application/json' && buffer.length < 5 * 1024 * 1024) {
      try {
        JSON.parse(buffer.toString('utf-8'));
      } catch {
        throw new AppError(
          'Invalid JSON format: Content failed JSON syntax validation',
          HTTP_STATUS.BAD_REQUEST
        );
      }
    }
  }
}

