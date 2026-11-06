# PHASE 2.1: PEERLEARN CLOUDFLARE R2 STORAGE INTEGRATION REPORT

**Project:** PeerLearn — Learn Together. Grow Together.  
**Architect:** Senior Backend Engineer & Cloud Storage Architect  
**Date:** November 6, 2026  
**Status:** COMPLETED — 100% OF STORAGE INVARIANTS SATISFIED  
**Test Coverage:** 12 Test Suites (187 / 187 Passing Tests, 0 Failures)  
**TypeScript Typecheck:** Clean (0 Errors)  
**Production Builds:** API Clean (`tsc`), Web Clean (`vite` / 2833 modules)  

---

## 1. Existing Storage Architecture Assessment

Prior to Phase 2.1, PeerLearn persisted uploaded learning documents (PDFs, notes, cheat-sheets, code examples) exclusively on the local container disk inside an `uploads/` directory on the Node.js backend.

### Critical Production Vulnerability Identified:
- **Ephemeral Container Storage Data Loss:** Render containers are ephemeral. On each deployment, container restart, or scaling event, the local container disk is completely wiped. Any student files uploaded to `/uploads` on Render disappeared permanently, breaking student download links and causing database orphaned references.
- **Single-Server Coupled File Access:** Files could only be streamed from the specific server instance running Express that accepted the upload.

---

## 2. Complete Upload Feature Inventory

A full codebase audit was conducted across backend routes, controllers, services, database models, and frontend components to identify every file upload, download, and reference mechanism:

| Feature / Domain | Route / Method | Controller / Service | Data Model Reference | Current Storage Mechanism | Status in Phase 2.1 |
|---|---|---|---|---|---|
| **Student Learning Documents** | `POST /api/resources` (multipart/form-data) | `handleCreateResource` -> `resource.service.ts` -> `storageService.saveFile` | `LearningResource.fileKey` (UUIDv4 + ext), `fileName`, `fileSize`, `mimeType` | Saved via `storageService` with 15MB size limit & MIME filtering | **Fully Integrated with R2 Abstraction** |
| **Document Streaming Download** | `GET /api/resources/:id/download` | `handleDownloadFile` -> `resource.service.ts` -> `storageService.getFileStream` | `LearningResource.fileKey` | Streamed through Express to browser with `Content-Disposition` & `nosniff` | **Streamed from R2 with optional Presigned Redirect** |
| **Document Deletion & Cleanup** | `DELETE /api/resources/:id` | `handleDeleteResource` -> `resource.service.ts` -> `storageService.deleteFile` | `LearningResource.fileKey` | File deleted from disk, DB record removed | **Deletes from R2 object store** |
| **Student Avatar Management** | `PATCH /api/profile` (JSON) | `handleUpdateProfile` -> `profile.service.ts` | `User.avatarUrl` | External URL string passed via JSON; no raw file upload endpoint existed | **Unchanged (URL field preserved)** |
| **Collaborative Code Workspaces** | `POST /api/code-workspaces` | `codeWorkspace.controller.ts` -> `codeWorkspace.service.ts` | `CodeDocument.content` (`@db.Text`), `DocumentRevision.content` | Stored as text / revisions in PostgreSQL database | **No file uploads needed (Database-managed)** |
| **Interactive Whiteboard Revisions** | `POST /api/study-rooms/:id/board/save` | `studyRoom.controller.ts` -> `studyRoom.service.ts` | `WhiteboardDocument.elements` (`Json`), `WhiteboardRevision.elements` | Stored as structured vector JSON in PostgreSQL | **No file uploads needed (Database-managed)** |

---

## 3. Files Inspected

- `apps/api/src/services/storage.service.ts` (Existing local filesystem storage logic)
- `apps/api/src/controllers/resource.controller.ts` (Resource creation and streaming download controller)
- `apps/api/src/services/resource.service.ts` (Resource business logic, fileKey binding, permission checks)
- `apps/api/src/routes/resource.routes.ts` (Multer memory storage configuration & route bindings)
- `apps/api/src/services/profile.service.ts` (Profile & avatar handling)
- `apps/api/src/config/env.ts` (Environment variable schema and Zod validation)
- `prisma/schema.prisma` (`User`, `StudentProfile`, `LearningResource` models)
- `apps/web/src/components/workspace/FileUpload.tsx` (Frontend 15MB drag-and-drop file upload UI)
- `apps/web/src/services/api.ts` (Frontend API service for multipart resource uploads and downloads)
- `apps/api/tests/sessions_workspace_dashboard.test.ts` (Existing resource API integration tests)

---

## 4. Files Created and Modified

### Created:
1. `apps/api/src/services/storage/storage.types.ts`: Core storage abstraction interfaces (`StorageProvider`, `UploadedFileMetadata`, `FileMetadata`, `R2Config`, permitted MIME types, max file sizes).
2. `apps/api/src/services/storage/local.provider.ts`: `LocalStorageProvider` implementation for development and testing environments, with strict path traversal defenses.
3. `apps/api/src/services/storage/r2.provider.ts`: `R2StorageProvider` implementation using the official AWS S3 SDK for Cloudflare R2 (`PutObjectCommand`, `GetObjectCommand`, `DeleteObjectCommand`, `HeadObjectCommand`, and presigned URL generation).
4. `apps/api/tests/storage_r2_phase2_1.test.ts`: 18 comprehensive automated tests verifying client configuration, upload/download/delete lifecycle, configuration guards, access controls, traversal defenses, and streaming compatibility.

### Modified:
1. `apps/api/package.json`: Added `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`.
2. `apps/api/src/config/env.ts`: Added `STORAGE_PROVIDER`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, and `R2_PUBLIC_URL` with strict production validation.
3. `apps/api/src/services/storage.service.ts`: Upgraded from a local-only file helper to a multi-provider facade that enforces production R2 mandates, safe UUID key generation, MIME sanitization, and structured logging.
4. `apps/api/src/controllers/resource.controller.ts`: Added support for optional presigned download URL redirection (`?redirect=true`) while preserving streaming downloads.
5. `.env.example`: Added detailed configuration documentation for Cloudflare R2.

---

## 5. Packages Added

Installed in `@peerlume/api`:
- `@aws-sdk/client-s3` (`^3.758.0`): Official S3 client library used to interact with Cloudflare R2's S3-compatible API.
- `@aws-sdk/s3-request-presigner` (`^3.758.0`): Presigned URL generator for secure, time-limited private downloads.

Zero vulnerable subdependencies introduced.

---

## 6. Cloudflare R2 Architecture & Implementation

### S3-Compatible API Endpoint Format:
```
https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com
```

### Provider Configuration:
```typescript
const client = new S3Client({
  region: 'auto', // Required by Cloudflare R2
  endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  },
});
```

### Storage Abstraction Architecture:
```
┌────────────────────────────────────────────────────────────────────────┐
│                        PeerLearn Storage Facade                         │
│                     (storageService in storage.service.ts)             │
│                                                                        │
│ - Validates 15MB size limit                                            │
│ - Sanitizes MIME types and original filenames                          │
│ - Generates cryptographically secure UUID object keys                  │
│ - Defends against path traversal attacks                               │
│ - Emits structured audit logs (never logs secrets or URLs)             │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        StorageProvider Interface                       │
│  upload() | download() | getDownloadUrl() | delete() | exists() | meta │
└──────────────────┬─────────────────────────────────┬───────────────────┘
                   │                                 │
                   ▼                                 ▼
   ┌───────────────────────────────┐ ┌───────────────────────────────────┐
   │       R2StorageProvider       │ │        LocalStorageProvider       │
   │   (Cloudflare R2 - S3 API)    │ │   (Local /uploads - Dev & Test)   │
   │                               │ │                                   │
   │  - PutObjectCommand           │ │  - fs.promises.writeFile          │
   │  - GetObjectCommand           │ │  - fs.createReadStream            │
   │  - DeleteObjectCommand        │ │  - fs.promises.unlink             │
   │  - HeadObjectCommand          │ │  - Strict path traversal defense  │
   │  - getSignedUrl (Presigner)   │ │                                   │
   │  - MANDATORY IN PRODUCTION    │ │  - PROHIBITED IN PRODUCTION       │
   └───────────────────────────────┘ └───────────────────────────────────┘
```

---

## 7. Environment Variables Required

The following environment variables have been added to the application schema:

| Variable | Description | Requirement | Example / Default |
|---|---|---|---|
| `STORAGE_PROVIDER` | Active storage provider backend | Required (`local` or `r2`) | `r2` in production, `local` in development |
| `R2_ACCOUNT_ID` | Cloudflare Account ID (from dashboard) | Required when `STORAGE_PROVIDER=r2` | `e2a4b8...` |
| `R2_ACCESS_KEY_ID` | R2 API Token Access Key ID | Required when `STORAGE_PROVIDER=r2` | `0123456789abcdef...` |
| `R2_SECRET_ACCESS_KEY` | R2 API Token Secret Access Key | Required when `STORAGE_PROVIDER=r2` | `9876543210fedcba...` (Never logged) |
| `R2_BUCKET_NAME` | R2 Bucket Name for PeerLearn files | Required when `STORAGE_PROVIDER=r2` | `peerlearn-production-files` |
| `R2_PUBLIC_URL` | Optional public CDN URL | Optional (kept private by default) | `https://pub-xxxxxx.r2.dev` |

### Production Fail-Fast Validation:
In `apps/api/src/config/env.ts` and `apps/api/src/services/storage.service.ts`:
- If `NODE_ENV === 'production'` and `STORAGE_PROVIDER === 'local'`, the application refuses to start with:  
  `CRITICAL: Local ephemeral filesystem storage is prohibited in production. Cloudflare R2 must be configured.`
- If `STORAGE_PROVIDER === 'r2'` and any required credential is missing or blank, the application refuses to start with a descriptive error.
- Silent fallback to ephemeral storage in production is completely prevented.

---

## 8. Security Implementation

1. **Random Unguessable Object Keys:** Object keys are generated as cryptographically random UUID v4 values with the validated extension:
   ```typescript
   const randomKey = `${crypto.randomUUID()}${expectedExtension}`; // e.g. "a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf"
   ```
2. **Directory & Path Traversal Immunity:** Object keys are validated against strict regex `/^[0-9a-fA-F-]{36}\.[a-zA-Z0-9]+$/`. Any key containing navigation characters (`../`, `..\`, absolute paths) is rejected with `400 BAD_REQUEST`.
3. **MIME Type & Extension Whitelisting:** Client-provided `Content-Type` is checked against `PERMITTED_MIME_TYPES`. In addition, the original filename extension is checked against `PERMITTED_EXTENSIONS` to prevent attackers from renaming executable scripts (`exploit.sh`, `malware.exe`) to spoof image or PDF MIME types.
4. **File Size Enforcement:** Both Multer (`limits: { fileSize: 15 * 1024 * 1024 }`) and `storageService.saveFile` independently enforce a strict 15MB ceiling.
5. **Private File Authorization:** Student files remain completely private in R2 (bucket is NOT public). Downloads require authentication (`requireAuth`) and authorization (`getResourceById`). Non-authors cannot download private files (`403 FORBIDDEN`).
6. **Time-Limited Presigned URLs:** Presigned URLs (generated via `getDownloadUrl()`) expire in 5 minutes (300 seconds). URLs are generated on-the-fly and never stored in the database.
7. **Zero Secret Leakage:** R2 credentials, presigned URLs, and private file contents are excluded from all logging statements.

---

## 9. Backward Compatibility & Database Integrity

- **No Schema Changes Required:** The existing Prisma schema stores `fileKey String? @map("file_key")` in `LearningResource`. Because R2 stores files by their unique object key (e.g. `uuid.pdf`), existing database columns seamlessly store R2 object keys without schema alterations or migrations.
- **Controller Contract Preserved:** `storageService.saveFile()`, `storageService.getFileStream()`, and `storageService.deleteFile()` maintain their exact function signatures, parameter types, and return types.
- **Frontend Contract Preserved:** Standard downloads continue to stream transparently to the browser without requiring any frontend code changes or breaking existing user workflows.

---

## 10. Automated Test Results

A dedicated test suite was created and executed in `apps/api/tests/storage_r2_phase2_1.test.ts`, covering all 14 required audit scenarios:

```
================================================================================
                           VITEST EXECUTION SUMMARY
================================================================================
Test Files  12 passed (12)
     Tests  187 passed (187)
  Duration  22.27s

Breakdown:
  ✓ tests/storage_r2_phase2_1.test.ts (18 tests) [NEW CLOUD STORAGE SUITE]
      ✓ 1. R2 Client Configuration > initializes R2 client with S3-compatible config & auto region
      ✓ 2. Core R2 Storage Operations > successfully uploads buffer to R2 via PutObjectCommand
      ✓ 3. Core R2 Storage Operations > handles failed R2 upload by throwing safe AppError
      ✓ 4. Core R2 Storage Operations > successfully deletes object from R2 via DeleteObjectCommand
      ✓ 5. Configuration Validation > fails clearly when R2 is configured but required credentials missing
      ✓ 5. Configuration Validation > prohibits local ephemeral filesystem storage in production
      ✓ 6. Upload Security > rejects unsupported MIME type with 400 Bad Request
      ✓ 6b. Upload Security > rejects extension mismatch (e.g. executable extension claiming pdf mime)
      ✓ 7. Upload Security > rejects oversized files exceeding 15MB limit with 400 Bad Request
      ✓ 8. Upload Security > generates safe, unguessable UUID storage keys and strips traversal paths
      ✓ 9. Access Control > blocks non-author student from downloading private resource with 403
      ✓ 10. Access Control > rejects unauthenticated download attempt with 401
      ✓ 11. Access Control > prevents non-author student from deleting another student resource with 403
      ✓ 12. Missing Objects > returns clean 404 when requested object does not exist in R2
      ✓ 12. Missing Objects > exists() returns false when object is not found in R2
      ✓ 13. API Compatibility > streams R2 object through Express download endpoint to authorized student
      ✓ 14. Local Dev Provider > operates local filesystem provider in dev/test environment
      ✓ 14. Local Dev Provider > rejects path traversal attempts on local provider with 400 Bad Request
  ✓ tests/auth_verification_phase1_3.test.ts (30 tests)
  ✓ tests/auth_security_phase1_2.test.ts (21 tests)
  ✓ tests/auth_cookies.test.ts (8 tests)
  ✓ tests/auth.test.ts (9 tests)
  ✓ tests/health.test.ts (2 tests)
  ✓ tests/connections.test.ts (22 tests)
  ✓ tests/chat_calls_notifications.test.ts (18 tests)
  ✓ tests/sessions_workspace_dashboard.test.ts (16 tests)
  ✓ tests/code_workspace.test.ts (15 tests)
  ✓ tests/study_room_whiteboard_ux.test.ts (18 tests)
  ✓ tests/production_security_audit.test.ts (10 tests)
================================================================================
```

---

## 11. Remaining Configuration Tasks for Live Deployment

To activate Cloudflare R2 on the live Render backend deployment:

1. **Create Cloudflare R2 Bucket:**
   - Log into the Cloudflare Dashboard -> **R2 Object Storage**.
   - Click **Create bucket**, name it `peerlearn-production-files`, and select **Automatic** location.
2. **Generate API Token:**
   - In Cloudflare R2 Dashboard, click **Manage R2 API Tokens** -> **Create API Token**.
   - Permission: **Object Read & Write**.
   - Specific bucket: Select `peerlearn-production-files`.
   - Copy the generated `Access Key ID` and `Secret Access Key`.
3. **Set Render Environment Variables:**
   - In the Render Dashboard for `peerlearn-api-jumj`, set:
     - `STORAGE_PROVIDER` = `r2`
     - `R2_ACCOUNT_ID` = `<your_cloudflare_account_id>`
     - `R2_ACCESS_KEY_ID` = `<your_access_key_id>`
     - `R2_SECRET_ACCESS_KEY` = `<your_secret_access_key>`
     - `R2_BUCKET_NAME` = `peerlearn-production-files`

---

## 12. Deployment Readiness

- **Code Quality:** Zero compilation or type errors (`tsc --noEmit`).
- **Build Quality:** Clean production builds for both `@peerlume/api` and `@peerlume/web`.
- **System Stability:** 187 passing tests with zero regressions across all application domains.
- **Status:** **PHASE 2.1 COMPLETE — READY FOR LIVE PRODUCTION CONFIGURATION**.

Per our protocol, I have stopped here and await your explicit approval before proceeding to **Phase 2.2**.

