# Phase 1.2 — Authentication Security & Session Validation Report

**Project:** PeerLearn (*Learn Together. Grow Together.*)  
**Phase:** 1.2 Authentication Security & Session Validation  
**Date:** November 6, 2026  
**Status:** Verification Passed (139 / 139 Tests Passing)

---

## 1. Security Issues Discovered

During deep inspection of the authentication and session lifecycle, the following security gaps were identified and confirmed:

1. **Unconstrained JWT Algorithms on Token Verification (`utils/jwt.ts`)**:
   - `jwt.verify(token, secret)` did not specify the `algorithms` option. This left verification open to algorithm confusion or substitution attacks if non-HMAC headers were passed.
2. **Missing Token Reuse Detection on Revoked Refresh Tokens (`services/auth.service.ts`)**:
   - When an old, already-rotated refresh token was submitted to `/api/auth/refresh`, the server rejected it as `INVALID_SESSION`, but did not detect it as potential token theft or revoke the user's active session tree.
3. **Mismatched Session Hash Invariant in `auth.ts` vs `auth.service.ts`**:
   - `auth.service.ts` generated a random token, hashed it to `session.hashedToken`, but then issued a signed JWT refresh token containing `{ userId, sessionId }`.
   - In `apps/api/src/middleware/auth.ts`, `requireAuth` attempted to query `where: { hashedToken: hashToken(jwt) }`, which failed to match the database record because `session.hashedToken` stored the hash of an ephemeral random token rather than the JWT.
4. **CORS Rejection Throwing Unhandled 500 (`app.ts`)**:
   - Passing `callback(new Error('Origin ... not allowed by CORS'))` caused Express to handle disallowed CORS requests as uncaught 500 Internal Server Errors with potential stack disclosures instead of standard CORS browser blocks.
5. **Lack of CSRF Protection for Cross-Origin Cookies (`app.ts` & `middleware/csrf.ts`)**:
   - In cross-origin deployments (Vercel `peerlearn-teal.vercel.app` calling Render `peerlearn-api-jumj.onrender.com`), cookies are set with `SameSite=None; Secure`. Modern browsers attach `SameSite=None` cookies on cross-origin requests, leaving state-changing endpoints vulnerable to cross-site request forgery without Origin/Referer validation.

---

## 2. Confirmed Issues vs. False Positives

| Finding | Type | Evaluation |
|---------|------|------------|
| **JWT Algorithm Substitution** | Confirmed | `jwt.verify` lacked `algorithms: ['HS256']`. Fixed. |
| **Refresh Token Reuse Detection** | Confirmed | Rotated tokens were rejected but did not invalidate compromised user sessions. Fixed. |
| **Silent Refresh Session Lookup** | Confirmed | `requireAuth` searched by `hashedToken` of JWT instead of `sessionId`. Fixed. |
| **CORS 500 Error Crash** | Confirmed | Replaced `callback(new Error(...))` with `callback(null, false)`. Fixed. |
| **Cross-Origin CSRF Exposure** | Confirmed | Added `csrfProtection` middleware validating Origin/Referer on mutating cookie requests. Fixed. |
| **Password Plaintext Exposure** | False Positive | Passwords are securely hashed with Argon2id and never logged. |
| **Reset Token Multi-Use** | False Positive | Reset tokens in `passwordResetToken` already enforce single-use with `usedAt: new Date()` and invalidate all active user sessions on password change. |

---

## 3. Files Inspected

- `apps/api/src/utils/jwt.ts`
- `apps/api/src/services/auth.service.ts`
- `apps/api/src/controllers/auth.controller.ts`
- `apps/api/src/middleware/auth.ts`
- `apps/api/src/utils/cookies.ts`
- `apps/api/src/app.ts`
- `apps/api/src/config/env.ts`
- `apps/api/src/routes/auth.routes.ts`
- `prisma/schema.prisma` (`RefreshSession`, `Token`, `User`)
- `apps/api/tests/auth.test.ts`
- `apps/api/tests/auth_cookies.test.ts`
- `apps/api/tests/production_security_audit.test.ts`

---

## 4. Files Modified & Added

| File | Status | Description |
|------|--------|-------------|
| `apps/api/src/utils/jwt.ts` | Modified | Pinned `algorithm: 'HS256'` in `jwt.sign` and `algorithms: ['HS256']` in `jwt.verify`. |
| `apps/api/src/services/auth.service.ts` | Modified | Bound `session.hashedToken` directly to SHA-256 of issued refresh JWT. Added automated Token Reuse Detection that revokes all user sessions when a revoked token is presented. |
| `apps/api/src/middleware/auth.ts` | Modified | Updated silent refresh session lookup to use `refreshPayload.sessionId` and verify cryptographic token hash match. |
| `apps/api/src/app.ts` | Modified | Attached `csrfProtection` middleware; updated CORS rejection to `callback(null, false)`. |
| `apps/api/src/middleware/csrf.ts` | Created | Added Origin/Referer validation for mutating cookie-authenticated requests. Exempts safe `GET`/`HEAD` and `Bearer` headers. |
| `apps/api/tests/auth_security_phase1_2.test.ts` | Created | 21 comprehensive tests covering all 18 security requirements. |

---

## 5. Exact Fixes Implemented

### 5.1 Algorithm Pinning in [jwt.ts](file:///d:/Sachin%20Drive/Projects/PeerLearn/apps/api/src/utils/jwt.ts)
```typescript
export function verifyAccessToken(token: string): AccessTokenPayload | null {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: 'peerlume-api',
      algorithms: ['HS256'],
    }) as AccessTokenPayload;
  } catch {
    return null;
  }
}
```

### 5.2 Refresh Token Cryptographic Binding & Reuse Detection in [auth.service.ts](file:///d:/Sachin%20Drive/Projects/PeerLearn/apps/api/src/services/auth.service.ts)
- `sessionId` is created via `crypto.randomUUID()`.
- `refreshToken` (JWT) is signed and hashed via `hashToken(refreshToken)` into `session.hashedToken`.
- When an already-revoked refresh token is re-submitted:
  ```typescript
  if (session.isRevoked) {
    logger.warn(`[SECURITY] Revoked refresh token reuse detected for user ${session.userId}. Invalidating all active sessions.`);
    await prisma.refreshSession.updateMany({
      where: { userId: session.userId, isRevoked: false },
      data: { isRevoked: true },
    });
    throw new AppError('Session revoked. Please log in again.', HTTP_STATUS.UNAUTHORIZED, 'REVOKED_SESSION');
  }
  ```

### 5.3 CSRF Protection in [middleware/csrf.ts](file:///d:/Sachin%20Drive/Projects/PeerLearn/apps/api/src/middleware/csrf.ts)
- Inspects `Origin` and `Referer` headers for any mutating request (`POST`, `PUT`, `PATCH`, `DELETE`) carrying authentication cookies.
- Verifies origin against `env.WEB_ORIGIN` (and localhost regex in dev).
- Rejects untrusted origins with `403 Forbidden` (`CSRF_FORBIDDEN`).
- Safely permits read-only `GET`/`HEAD` requests and requests using explicit `Authorization: Bearer` headers.

---

## 6. Refresh-Token Rotation & Session Revocation Behavior

1. **Rotation:** Each call to `POST /api/auth/refresh` immediately revokes the old session (`isRevoked: true`) and creates a new `RefreshSession` row within a single atomic database `$transaction`.
2. **Reuse Detection:** If an old rotated refresh token is presented again (indicating token compromise or replay), all active sessions for that user are revoked immediately.
3. **Multi-Device Isolation:** Logging out on Device A revokes only Device A's session (`where: { id: payload.sessionId }`). Device B's session remains active and independent.
4. **Password Reset Revocation:** Resetting a password invalidates all active sessions for that user across all devices.

---

## 7. CSRF and CORS Validation

- **CORS:** Only `env.WEB_ORIGIN` (`https://peerlearn-teal.vercel.app`) and local development ports (`http://localhost:5173-5175`) are permitted. Credentials (`credentials: true`) are enabled only for these trusted origins. Disallowed origins return clean responses without CORS allow headers.
- **CSRF:** All cookie-authenticated state-changing calls from unauthorized origins are rejected with `403 Forbidden` (`CSRF_FORBIDDEN`).

---

## 8. Automated Test Execution Results

Command executed:
```powershell
npm --workspace=@peerlume/api test
```

**Results:**
- **Test Files:** `10 passed (10)`
- **Tests:** `139 passed (139)`
- **Duration:** `15.01s`

All 18 required security scenarios pass:
1. Valid access token.
2. Expired access token.
3. Invalid JWT signature.
4. Malformed JWT.
5. Expired refresh token.
6. Revoked refresh token.
7. Refresh-token rotation.
8. Old refresh-token reuse detection.
9. Concurrent refresh prevention.
10. Logout and session revocation.
11. Multiple-device session isolation.
12. Missing authentication.
13. Protected route authorization.
14. Login rate limiting headers.
15. CSRF protection on mutating cookie requests.
16. Password reset token expiration.
17. Password reset token single-use enforcement.
18. Password change session invalidation.

### Build and Typecheck Results:
- `npm --workspace=@peerlume/api run typecheck` $\rightarrow$ **0 errors (Passed)**
- `npm --workspace=@peerlume/api run build` $\rightarrow$ **Code 0 (Passed)**
- `npm --workspace=@peerlume/web run build` $\rightarrow$ **Code 0 (Passed)**

---

## 9. Remaining Security Risks

1. **Ephemeral File Storage (P0 - Phase 2):** Files uploaded to `/uploads` remain on the container's local disk until S3/R2 cloud storage migration in Phase 2.
2. **Resend Email Domain (P1):** Needs production domain DNS verification to send to arbitrary university student domains.
3. **WebRTC TURN (P1):** Needs production TURN credentials for symmetric institutional firewalls.

---

## 10. Deployment Readiness

**Phase 1.2 is 100% verified and READY FOR DEPLOYMENT.**
All authentication paths, token lifecycles, and session invariants are cryptographically hardened.

