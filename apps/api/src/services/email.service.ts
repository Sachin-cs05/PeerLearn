
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export interface EmailService {
  sendVerificationEmail(
    to: string,
    token: string,
    fullName: string
  ): Promise<boolean>;

  sendPasswordResetEmail(
    to: string,
    token: string,
    fullName: string
  ): Promise<boolean>;
}

interface EmailContent {
  to: string;
  subject: string;
  html: string;
  text: string;
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };

    return entities[character];
  });

function createEmailTemplate(
  heading: string,
  fullName: string,
  message: string,
  buttonText: string,
  actionUrl: string,
  expiryMessage: string,
  footerMessage: string
): string {
  const safeName = escapeHtml(fullName || 'there');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${heading} - PeerLearn</title>
</head>
<body style="margin:0;padding:0;background-color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e2e8f0;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#0f172a;padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:580px;background-color:#1e293b;border-radius:12px;border:1px solid #334155;overflow:hidden;">
          <tr>
            <td style="padding:32px 32px 24px;background:linear-gradient(135deg,#1e1b4b 0%,#312e81 100%);text-align:center;border-bottom:1px solid #3730a3;">
              <h1 style="margin:0;font-size:26px;font-weight:700;color:#ffffff;">PeerLearn</h1>
              <p style="margin:6px 0 0;font-size:13px;color:#a5b4fc;">Learn Together. Grow Together.</p>
            </td>
          </tr>

          <tr>
            <td style="padding:32px;font-size:15px;line-height:1.6;color:#cbd5e1;">
              <h2 style="margin:0 0 16px;font-size:20px;color:#ffffff;">${heading}</h2>

              <p>Hello <strong style="color:#ffffff;">${safeName}</strong>,</p>

              <p style="margin-bottom:24px;">${message}</p>

              <div style="text-align:center;margin:32px 0;">
                <a href="${actionUrl}" target="_blank"
                   style="display:inline-block;background-color:#6366f1;color:#ffffff;text-decoration:none;padding:14px 32px;font-size:15px;font-weight:600;border-radius:8px;">
                  ${buttonText}
                </a>
              </div>

              <p style="font-size:13px;color:#94a3b8;">
                If the button doesn't work, copy and paste this link into your browser:
              </p>

              <p style="font-size:12px;word-break:break-all;background-color:#0f172a;padding:12px;border-radius:6px;">
                <a href="${actionUrl}" style="color:#818cf8;">${actionUrl}</a>
              </p>

              <p style="font-size:13px;color:#94a3b8;">${expiryMessage}</p>
              <p style="font-size:13px;color:#64748b;">${footerMessage}</p>
            </td>
          </tr>

          <tr>
            <td style="padding:20px 32px;background-color:#0f172a;text-align:center;font-size:12px;color:#64748b;border-top:1px solid #1e293b;">
              &copy; ${new Date().getFullYear()} PeerLearn. All rights reserved.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

class DevelopmentEmailService implements EmailService {
  async sendVerificationEmail(
    to: string,
    token: string,
    fullName: string
  ): Promise<boolean> {
    const verifyUrl = `${env.APP_BASE_URL}/verify-email?token=${token}`;

    logger.info('[DEV EMAIL SINK - Verification]');
    logger.info(`To: ${fullName} <${to}>`);
    logger.info(`Link: ${verifyUrl}`);
    logger.info('Token expires in 24 hours');

    return true;
  }

  async sendPasswordResetEmail(
    to: string,
    token: string,
    fullName: string
  ): Promise<boolean> {
    const resetUrl = `${env.APP_BASE_URL}/reset-password?token=${token}`;

    logger.info('[DEV EMAIL SINK - Password Reset]');
    logger.info(`To: ${fullName} <${to}>`);
    logger.info(`Link: ${resetUrl}`);
    logger.info('Token expires in 15 minutes');

    return true;
  }
}

class SmtpEmailService implements EmailService {
  private transporter: Transporter;
  private fromAddress: string;

  constructor() {
    const port = Number(env.SMTP_PORT) || 587;
    const cleanPass = (env.SMTP_PASS || '').replace(/\s+/g, '');

    this.fromAddress = (
      env.EMAIL_FROM || `PeerLearn <${env.SMTP_USER}>`
    ).replace(/^["']|["']$/g, '');

    this.transporter = nodemailer.createTransport({
      host: env.SMTP_HOST || 'smtp.gmail.com',
      port,
      secure: port === 465,
      auth: {
        user: env.SMTP_USER,
        pass: cleanPass,
      },
    });

    logger.info(`[EMAIL] SMTP service initialized on port ${port}`);
  }

  private async sendEmail(content: EmailContent): Promise<boolean> {
    try {
      const info = await this.transporter.sendMail({
        from: this.fromAddress,
        to: content.to,
        subject: content.subject,
        html: content.html,
        text: content.text,
      });

      logger.info(`[EMAIL] SMTP email sent. MessageId: ${info.messageId}`);
      return true;
    } catch (error) {
      logger.error('[EMAIL] SMTP delivery failed:', error);
      return false;
    }
  }

  async sendVerificationEmail(
    to: string,
    token: string,
    fullName: string
  ): Promise<boolean> {
    const url = `${env.APP_BASE_URL}/verify-email?token=${token}`;

    return this.sendEmail({
      to,
      subject: 'Verify your email for PeerLearn',
      html: createEmailTemplate(
        'Verify Your Email Address',
        fullName,
        'Welcome to PeerLearn! Please verify your email address to activate your account.',
        'Verify Email Address',
        url,
        'This verification link will expire in 24 hours.',
        'If you did not sign up for PeerLearn, you can safely ignore this email.'
      ),
      text: `Hello ${fullName || 'there'},\n\nWelcome to PeerLearn! Verify your email here:\n${url}\n\nThis link expires in 24 hours.`,
    });
  }

  async sendPasswordResetEmail(
    to: string,
    token: string,
    fullName: string
  ): Promise<boolean> {
    const url = `${env.APP_BASE_URL}/reset-password?token=${token}`;

    return this.sendEmail({
      to,
      subject: 'Reset your password for PeerLearn',
      html: createEmailTemplate(
        'Reset Your Password',
        fullName,
        'We received a request to reset your PeerLearn account password.',
        'Reset Password',
        url,
        'This password reset link will expire in 15 minutes.',
        'If you did not request a password reset, you can safely ignore this email.'
      ),
      text: `Hello ${fullName || 'there'},\n\nReset your PeerLearn password here:\n${url}\n\nThis link expires in 15 minutes.`,
    });
  }
}

class ResendEmailService implements EmailService {
  private readonly apiKey: string;
  private readonly fromAddress: string;

  constructor() {
    if (!env.RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY is required for Resend email provider');
    }

    this.apiKey = env.RESEND_API_KEY;
    this.fromAddress =
      env.EMAIL_FROM || 'PeerLearn <onboarding@resend.dev>';

    logger.info('[EMAIL] ResendEmailService initialized');
  }

  private async sendEmail(content: EmailContent): Promise<boolean> {
    try {
      logger.info(`[EMAIL] Sending email through Resend to ${content.to}...`);

      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.fromAddress,
          to: [content.to],
          subject: content.subject,
          html: content.html,
          text: content.text,
        }),
        signal: AbortSignal.timeout(20000),
      });

      const responseBody = await response.text();

      if (!response.ok) {
        logger.error(
          `[EMAIL] Resend API failed with status ${response.status}: ${responseBody}`
        );
        return false;
      }

      let messageId = 'unknown';

      try {
        const result = JSON.parse(responseBody) as { id?: string };
        messageId = result.id || messageId;
      } catch {
        // The API accepted the request; response ID was unavailable.
      }

      logger.info(
        `[EMAIL] Resend accepted email for ${content.to}. MessageId: ${messageId}`
      );

      return true;
    } catch (error) {
      logger.error('[EMAIL] Resend email delivery request failed:', error);
      return false;
    }
  }

  async sendVerificationEmail(
    to: string,
    token: string,
    fullName: string
  ): Promise<boolean> {
    const url = `${env.APP_BASE_URL}/verify-email?token=${token}`;

    return this.sendEmail({
      to,
      subject: 'Verify your email for PeerLearn',
      html: createEmailTemplate(
        'Verify Your Email Address',
        fullName,
        'Welcome to PeerLearn! Please verify your email address to activate your account.',
        'Verify Email Address',
        url,
        'This verification link will expire in 24 hours.',
        'If you did not sign up for PeerLearn, you can safely ignore this email.'
      ),
      text: `Hello ${fullName || 'there'},\n\nWelcome to PeerLearn! Verify your email here:\n${url}\n\nThis link expires in 24 hours.`,
    });
  }

  async sendPasswordResetEmail(
    to: string,
    token: string,
    fullName: string
  ): Promise<boolean> {
    const url = `${env.APP_BASE_URL}/reset-password?token=${token}`;

    return this.sendEmail({
      to,
      subject: 'Reset your password for PeerLearn',
      html: createEmailTemplate(
        'Reset Your Password',
        fullName,
        'We received a request to reset your PeerLearn account password.',
        'Reset Password',
        url,
        'This password reset link will expire in 15 minutes.',
        'If you did not request a password reset, you can safely ignore this email.'
      ),
      text: `Hello ${fullName || 'there'},\n\nReset your PeerLearn password here:\n${url}\n\nThis link expires in 15 minutes.`,
    });
  }
}

function createEmailService(): EmailService {
  if (env.NODE_ENV === 'test') {
    return new DevelopmentEmailService();
  }

  if (env.EMAIL_PROVIDER === 'resend') {
    return new ResendEmailService();
  }

  if (
    env.EMAIL_PROVIDER === 'smtp' &&
    env.SMTP_USER &&
    env.SMTP_PASS
  ) {
    return new SmtpEmailService();
  }

  return new DevelopmentEmailService();
}

export const emailService: EmailService = createEmailService();
