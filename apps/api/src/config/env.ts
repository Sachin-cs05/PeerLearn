
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Load .env from root or current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });
dotenv.config(); // fallback to local cwd .env

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  PORT: z
    .string()
    .default('5000')
    .transform((val) => {
      const parsed = Number.parseInt(val, 10);

      if (Number.isNaN(parsed) || parsed <= 0 || parsed > 65535) {
        throw new Error(`Invalid PORT value: ${val}`);
      }

      return parsed;
    }),

  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  APP_BASE_URL: z.string().default('http://localhost:5173'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL environment variable is required'),

  // Authentication Secrets
  JWT_ACCESS_SECRET: z
    .string()
    .min(16, 'JWT_ACCESS_SECRET must be at least 16 characters')
    .default('peerlume_dev_jwt_access_secret_super_secure_32chars!'),

  JWT_REFRESH_SECRET: z
    .string()
    .min(16, 'JWT_REFRESH_SECRET must be at least 16 characters')
    .default('peerlume_dev_jwt_refresh_secret_super_secure_32chars!'),

  COOKIE_SECRET: z
    .string()
    .min(16, 'COOKIE_SECRET must be at least 16 characters')
    .default('peerlume_dev_cookie_signing_secret_super_secure!'),

  // Email Configuration
  EMAIL_PROVIDER: z
    .enum(['development', 'smtp', 'resend'])
    .default('development'),

  RESEND_API_KEY: z.string().optional(),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),

  EMAIL_FROM: z
    .string()
    .default('PeerLearn <noreply@peerlearn.local>'),

  // WebRTC STUN/TURN Configuration
  STUN_SERVERS: z
    .string()
    .default('stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'),

  TURN_SERVER: z.string().optional(),
  TURN_USERNAME: z.string().optional(),
  TURN_CREDENTIAL: z.string().optional(),

  // Cloud Storage Configuration (Cloudflare R2 - S3-compatible API)
  STORAGE_PROVIDER: z.enum(['local', 'r2']).default('local'),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET_NAME: z.string().optional(),
  R2_PUBLIC_URL: z.string().optional(),

  // Storage Background Reconciliation Worker
  STORAGE_RECONCILIATION_ENABLED: z
    .string()
    .default('true')
    .transform((val) => val === 'true' || val === '1'),

  STORAGE_RECONCILIATION_INTERVAL_MS: z
    .string()
    .default('60000')
    .transform((val) => {
      const parsed = Number.parseInt(val, 10);
      if (Number.isNaN(parsed) || parsed < 1000) {
        throw new Error('STORAGE_RECONCILIATION_INTERVAL_MS must be at least 1000ms');
      }
      return parsed;
    }),

}).superRefine((data, ctx) => {

  // Production Secret Validation
  if (data.NODE_ENV === 'production') {
    const secrets = [
      { name: 'JWT_ACCESS_SECRET', value: data.JWT_ACCESS_SECRET },
      { name: 'JWT_REFRESH_SECRET', value: data.JWT_REFRESH_SECRET },
      { name: 'COOKIE_SECRET', value: data.COOKIE_SECRET },
    ];

    for (const { name, value } of secrets) {
      if (value.length < 32 || value.includes('peerlume_dev')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${name} must be a secure production secret (at least 32 characters and cannot contain "peerlume_dev") when NODE_ENV is production`,
          path: [name],
        });
      }
    }
  }

  // Resend API Key Validation
  if (data.EMAIL_PROVIDER === 'resend' && !data.RESEND_API_KEY?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'RESEND_API_KEY is required when EMAIL_PROVIDER is resend',
      path: ['RESEND_API_KEY'],
    });
  }

  // SMTP Configuration Validation
  if (
    data.EMAIL_PROVIDER === 'smtp' &&
    (!data.SMTP_USER || !data.SMTP_PASS)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'SMTP_USER and SMTP_PASS are required when EMAIL_PROVIDER is smtp',
      path: ['SMTP_USER'],
    });
  }

  // Storage Provider & Cloudflare R2 Validation
  // Local storage is explicitly allowed in production for ephemeral platforms (e.g., Render)
  if (data.STORAGE_PROVIDER === 'r2') {
    const r2Fields = [
      { name: 'R2_ACCOUNT_ID', value: data.R2_ACCOUNT_ID },
      { name: 'R2_ACCESS_KEY_ID', value: data.R2_ACCESS_KEY_ID },
      { name: 'R2_SECRET_ACCESS_KEY', value: data.R2_SECRET_ACCESS_KEY },
      { name: 'R2_BUCKET_NAME', value: data.R2_BUCKET_NAME },
    ];

    for (const { name, value } of r2Fields) {
      if (!value || value.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${name} is required when STORAGE_PROVIDER is r2`,
          path: [name],
        });
      }
    }
  }

});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('❌ Invalid environment variables configuration:');

  for (const issue of parsedEnv.error.issues) {
    console.error(`   - ${issue.path.join('.')}: ${issue.message}`);
  }

  process.exit(1);
}

export const env = parsedEnv.data;
export type Env = z.infer<typeof envSchema>;
