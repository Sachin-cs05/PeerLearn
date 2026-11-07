import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../../config/prisma.js';
import { logger } from '../../utils/logger.js';

export type ReconciliationTaskType = 'ORPHAN_STORAGE_KEY' | 'DANGLING_DB_RESOURCE';
export type ReconciliationStatus = 'PENDING' | 'PROCESSING' | 'RESOLVED' | 'FAILED';
export type StoragePersistenceTier = 'database' | 'persistent_disk' | 'ephemeral_fallback' | 'unpersisted';

export interface ReconciliationTask {
  id: string;
  taskType: ReconciliationTaskType;
  type?: ReconciliationTaskType;
  fileKey?: string | null;
  resourceId?: string | null;
  status: ReconciliationStatus;
  retryCount: number;
  maxRetries: number;
  lastError?: string | null;
  lockedAt?: Date | null;
  lockedBy?: string | null;
  leaseToken?: string | null;
  createdAt: Date;
  updatedAt: Date;
  persisted?: boolean;
  storageTier?: StoragePersistenceTier;
}

export interface ClaimTaskOptions {
  force?: boolean;
  leaseToken?: string;
}

export interface PersistTaskResult {
  persisted: boolean;
  storage: StoragePersistenceTier;
  error?: string;
}

export interface StorageReconciliationOptions {
  customStorePath?: string;
  persistentDiskDir?: string;
  allowEphemeralFallbackInProduction?: boolean;
  lockLeaseMs?: number;
}

export class StorageReconciliationService {
  private inMemoryCache: Map<string, ReconciliationTask> = new Map();
  private filePath: string | null = null;
  private persistentDiskDir: string | null = null;
  private isPersistentDiskConfigured: boolean = false;
  private allowDiskFallback: boolean = false;
  private readonly defaultMaxRetries = 5;
  private readonly lockLeaseMs: number;

  constructor(options?: string | StorageReconciliationOptions) {
    const opts: StorageReconciliationOptions =
      typeof options === 'string' ? { customStorePath: options } : options || {};

    this.lockLeaseMs = opts.lockLeaseMs ?? (5 * 60 * 1000); // 5 minute lock lease by default

    const configuredPersistentDir =
      opts.persistentDiskDir || process.env.STORAGE_RECONCILIATION_PERSISTENT_DISK_PATH || null;

    if (configuredPersistentDir) {
      try {
        if (!fs.existsSync(configuredPersistentDir)) {
          fs.mkdirSync(configuredPersistentDir, { recursive: true });
        }
        this.persistentDiskDir = configuredPersistentDir;
        this.filePath = path.join(configuredPersistentDir, 'storage-reconciliation-store.json');
        this.isPersistentDiskConfigured = true;
        this.allowDiskFallback = true;
      } catch (err: any) {
        logger.error('[STORAGE_RECONCILIATION] Failed to initialize configured persistent disk path', {
          path: configuredPersistentDir,
          error: err.message,
        });
        this.isPersistentDiskConfigured = false;
        this.allowDiskFallback = false;
      }
    } else {
      this.isPersistentDiskConfigured = false;
      // In production, ephemeral root filesystem is NEVER treated as durable storage.
      // Render web service containers lose root files on restarts/deployments.
      if (process.env.NODE_ENV === 'production' && !opts.allowEphemeralFallbackInProduction) {
        this.allowDiskFallback = false;
        this.filePath = null;
      } else {
        // Dev/test environments: allow local JSON file fallback for developer convenience
        this.allowDiskFallback = true;
        this.filePath = opts.customStorePath || path.join(process.cwd(), '.storage-reconciliation-store.json');
      }
    }

    if (this.allowDiskFallback && this.filePath) {
      this.loadFromDisk();
    }
  }

  /**
   * Sanitizes error messages to prevent credential, token, or secret leakage
   */
  public sanitizeError(err?: unknown): string {
    if (!err) return '';
    const raw = typeof err === 'string' ? err : (err as Error).message || String(err);
    return raw
      .replace(/(?:key|secret|token|password|cred)[a-z0-9_-]*\s*[:=]\s*[^\s,]+/gi, '[REDACTED]')
      .substring(0, 1000);
  }

  /**
   * Loads persisted tasks from disk if fallback or persistent disk is active
   */
  private loadFromDisk(): void {
    if (!this.filePath) return;
    try {
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, 'utf-8');
        const tasks: any[] = JSON.parse(content);
        for (const t of tasks) {
          this.inMemoryCache.set(t.id, {
            ...t,
            createdAt: new Date(t.createdAt),
            updatedAt: new Date(t.updatedAt),
            lockedAt: t.lockedAt ? new Date(t.lockedAt) : null,
          });
        }
      }
    } catch (err: any) {
      logger.warn('[STORAGE_RECONCILIATION] Failed to load store from disk', {
        error: err.message,
      });
    }
  }

  /**
   * Flushes tasks to disk if persistent disk or dev fallback is permitted
   */
  private flushToDisk(): void {
    if (!this.allowDiskFallback || !this.filePath) return;
    try {
      const tasks = Array.from(this.inMemoryCache.values());
      fs.writeFileSync(this.filePath, JSON.stringify(tasks, null, 2), 'utf-8');
    } catch (err: any) {
      logger.warn('[STORAGE_RECONCILIATION] Failed to flush store to disk', {
        error: err.message,
      });
    }
  }

  /**
   * Returns current persistence tier capabilities
   */
  public getCapabilities(): {
    isProduction: boolean;
    isPersistentDiskConfigured: boolean;
    allowDiskFallback: boolean;
    storePath: string | null;
  } {
    return {
      isProduction: process.env.NODE_ENV === 'production',
      isPersistentDiskConfigured: this.isPersistentDiskConfigured,
      allowDiskFallback: this.allowDiskFallback,
      storePath: this.filePath,
    };
  }

  /**
   * Persists a task.
   * In production: PostgreSQL is the authoritative store.
   * If PostgreSQL fails in production and no validated persistent disk is configured,
   * it emits an actionable critical operational alert and marks the task as unpersisted.
   */
  async persistTask(task: ReconciliationTask): Promise<PersistTaskResult> {
    this.inMemoryCache.set(task.id, task);

    if (this.allowDiskFallback) {
      this.flushToDisk();
    }

    // 1. Database-level persistence
    const isIsolatedTestDb = Boolean(process.env.STORAGE_TEST_DATABASE_URL) || process.env.ISOLATED_TEST_DB === 'true';
    const shouldWriteToDb = (prisma as any).storageReconciliation &&
      (process.env.NODE_ENV !== 'test' || isIsolatedTestDb);

    try {
      if (shouldWriteToDb) {
        await (prisma as any).storageReconciliation.upsert({
          where: { id: task.id },
          create: {
            id: task.id,
            taskType: task.taskType,
            fileKey: task.fileKey || null,
            resourceId: task.resourceId || null,
            status: task.status,
            retryCount: task.retryCount,
            maxRetries: task.maxRetries,
            lastError: task.lastError || null,
            lockedAt: task.lockedAt || null,
            lockedBy: task.lockedBy || null,
          },
          update: {
            status: task.status,
            retryCount: task.retryCount,
            lastError: task.lastError || null,
            lockedAt: task.lockedAt || null,
            lockedBy: task.lockedBy || null,
          },
        });

        task.persisted = true;
        task.storageTier = 'database';
        return { persisted: true, storage: 'database' };
      }
    } catch (dbErr: any) {
      const sanitized = this.sanitizeError(dbErr);

      if (this.isPersistentDiskConfigured) {
        logger.warn('[STORAGE_RECONCILIATION] PostgreSQL unavailable; persisted to configured persistent disk', {
          taskId: task.id,
          reason: sanitized,
        });
        task.persisted = true;
        task.storageTier = 'persistent_disk';
        return { persisted: true, storage: 'persistent_disk' };
      }

      if (process.env.NODE_ENV !== 'production' || this.allowDiskFallback) {
        logger.warn('[STORAGE_RECONCILIATION] Database persistence unavailable; falling back to local dev store', {
          taskId: task.id,
          reason: sanitized,
        });
        task.persisted = true;
        task.storageTier = 'ephemeral_fallback';
        return { persisted: true, storage: 'ephemeral_fallback' };
      }

      // Production with no persistent disk configured: DO NOT silently claim durability!
      logger.error('[STORAGE_RECONCILIATION_CRITICAL] PostgreSQL persistence failed in production and no persistent disk is configured. Task NOT durably registered!', {
        taskId: task.id,
        reason: sanitized,
      });

      task.persisted = false;
      task.storageTier = 'unpersisted';
      return {
        persisted: false,
        storage: 'unpersisted',
        error: `PostgreSQL persistence failed in production: ${sanitized}`,
      };
    }

    // Default if prisma model is not registered yet
    if (this.isPersistentDiskConfigured) {
      task.persisted = true;
      task.storageTier = 'persistent_disk';
      return { persisted: true, storage: 'persistent_disk' };
    }

    if (process.env.NODE_ENV !== 'production' || this.allowDiskFallback) {
      task.persisted = true;
      task.storageTier = 'ephemeral_fallback';
      return { persisted: true, storage: 'ephemeral_fallback' };
    }

    task.persisted = false;
    task.storageTier = 'unpersisted';
    return { persisted: false, storage: 'unpersisted', error: 'StorageReconciliation table not deployed' };
  }

  /**
   * Durably records an orphaned storage key that failed compensating cleanup
   */
  async recordOrphanStorageKey(
    fileKey: string,
    reason: string = 'ORPHAN_KEY',
    details?: string
  ): Promise<ReconciliationTask> {
    const id = `orphan-${crypto.randomUUID()}`;
    const task: ReconciliationTask = {
      id,
      taskType: 'ORPHAN_STORAGE_KEY',
      type: 'ORPHAN_STORAGE_KEY',
      fileKey,
      resourceId: null,
      status: 'PENDING',
      retryCount: 0,
      maxRetries: this.defaultMaxRetries,
      lastError: this.sanitizeError(`${reason}: ${details || ''}`),
      lockedAt: null,
      lockedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const persistResult = await this.persistTask(task);

    if (persistResult.persisted) {
      logger.info('[STORAGE_RECONCILIATION] Successfully registered orphaned storage key', {
        taskId: id,
        fileKey,
        storageTier: persistResult.storage,
      });
    } else {
      logger.error('[STORAGE_RECONCILIATION_CRITICAL] Failed to durably register orphaned storage key', {
        taskId: id,
        fileKey,
        reason: persistResult.error,
      });
    }

    return task;
  }

  /**
   * Durably records a dangling database record where R2 object deletion succeeded
   * but PostgreSQL record deletion failed.
   */
  async recordDanglingDbResource(
    resourceId: string,
    fileKey?: string | null,
    reason: string = 'DB_DELETE_FAILED',
    details?: string
  ): Promise<ReconciliationTask> {
    const id = `dangling-${crypto.randomUUID()}`;
    const task: ReconciliationTask = {
      id,
      taskType: 'DANGLING_DB_RESOURCE',
      type: 'DANGLING_DB_RESOURCE',
      fileKey: fileKey || null,
      resourceId,
      status: 'PENDING',
      retryCount: 0,
      maxRetries: this.defaultMaxRetries,
      lastError: this.sanitizeError(`${reason}: ${details || ''}`),
      lockedAt: null,
      lockedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const persistResult = await this.persistTask(task);

    if (persistResult.persisted) {
      logger.info('[STORAGE_RECONCILIATION] Successfully registered dangling database record', {
        taskId: id,
        resourceId,
        storageTier: persistResult.storage,
      });
    } else {
      logger.error('[STORAGE_RECONCILIATION_CRITICAL] Failed to durably register dangling database record', {
        taskId: id,
        resourceId,
        reason: persistResult.error,
      });
    }

    return task;
  }

  /**
   * Atomically claims a task for a worker.
   * Guarantees that concurrent workers cannot claim the same task.
   * Assigns a cryptographically secure unique UUID leaseToken to every claim for strict fencing.
   * Expired leases (> lockLeaseMs) can be reclaimed. Active leases are strictly protected.
   */
  async claimTask(taskId: string, workerId: string, options?: ClaimTaskOptions): Promise<boolean> {
    const now = Date.now();
    const leaseCutoff = new Date(now - this.lockLeaseMs);
    const cachedTask = this.inMemoryCache.get(taskId);

    // 1. Enforce unique cryptographically secure UUID leaseToken for every claim
    const leaseToken = options?.leaseToken || (workerId.includes(':') ? workerId.split(':')[1] : crypto.randomUUID());
    if (options) {
      options.leaseToken = leaseToken;
    }
    const pureWorkerId = workerId.includes(':') ? workerId.split(':')[0] : workerId;
    const leaseIdentity = `${pureWorkerId}:${leaseToken}`;

    const isIsolatedTestDb = Boolean(process.env.STORAGE_TEST_DATABASE_URL) || process.env.ISOLATED_TEST_DB === 'true';
    const shouldAccessDb = (prisma as any).storageReconciliation &&
      (process.env.NODE_ENV !== 'test' || isIsolatedTestDb);

    // 1. Try PostgreSQL atomic update if model is available and task was persisted in DB
    if ((cachedTask?.storageTier === 'database' || !cachedTask) && shouldAccessDb) {
      try {
        const result = await (prisma as any).storageReconciliation.updateMany({
          where: {
            id: taskId,
            OR: [
              { status: 'PENDING' },
              {
                status: 'PROCESSING',
                lockedAt: { lt: leaseCutoff },
              },
            ],
          },
          data: {
            status: 'PROCESSING',
            lockedAt: new Date(),
            lockedBy: leaseIdentity,
            retryCount: { increment: 1 },
            updatedAt: new Date(),
          },
        });

        if (result.count === 1) {
          // Successfully claimed at DB level! Update in-memory state
          if (cachedTask) {
            cachedTask.status = 'PROCESSING';
            cachedTask.lockedAt = new Date();
            cachedTask.lockedBy = leaseIdentity;
            cachedTask.leaseToken = leaseToken;
            cachedTask.retryCount += 1;
            cachedTask.updatedAt = new Date();
          }
          return true;
        }

        // If explicitly stored in DB and count is 0, task is either already claimed or lease active
        if (cachedTask?.storageTier === 'database') {
          return false;
        }
      } catch (dbErr: any) {
        if (process.env.NODE_ENV === 'production' && !this.isPersistentDiskConfigured) {
          logger.error('[STORAGE_RECONCILIATION_CRITICAL] Atomic claim failed due to PostgreSQL unavailability in production', {
            taskId,
            workerId: pureWorkerId,
            error: this.sanitizeError(dbErr),
          });
          return false;
        }
        // In dev/test with DB down, fall through to in-memory atomic claim
      }
    }

    // 2. Synchronous in-memory atomic claim for test/fallback store
    const task = cachedTask;
    if (!task) return false;

    if (task.status === 'RESOLVED' || task.status === 'FAILED') {
      return false;
    }

    const isPending = task.status === 'PENDING';
    const isLeaseExpired =
      task.status === 'PROCESSING' &&
      task.lockedAt &&
      now - task.lockedAt.getTime() >= this.lockLeaseMs;

    if (!isPending && !isLeaseExpired) {
      return false; // Active lease held by another worker
    }

    // Exponential backoff check unless forced
    const backoffMs = Math.min(1000 * Math.pow(2, task.retryCount), 300000);
    if (!options?.force && task.retryCount > 0 && now - task.updatedAt.getTime() < backoffMs) {
      return false;
    }

    // Atomic claim within Node.js event turn
    task.status = 'PROCESSING';
    task.lockedAt = new Date();
    task.lockedBy = leaseIdentity;
    task.leaseToken = leaseToken;
    task.retryCount += 1;
    task.updatedAt = new Date();

    if (this.allowDiskFallback) {
      this.flushToDisk();
    }

    return true;
  }

  /**
   * Releases a claimed task after a failed attempt.
   * Strictly enforces worker lease fencing: validates lease identity so stale workers cannot overwrite newer locks.
   * STRICT: Requires a valid, non-empty leaseToken matching the active claim.
   */
  async releaseTask(
    taskId: string,
    workerId: string,
    leaseTokenOrError?: string | unknown,
    errorOrLeaseToken?: unknown
  ): Promise<boolean> {
    let cleanToken: string | null = null;
    let rawError: unknown = undefined;

    if (typeof leaseTokenOrError === 'string' && leaseTokenOrError.trim()) {
      cleanToken = leaseTokenOrError.trim();
      rawError = errorOrLeaseToken;
    } else if (typeof errorOrLeaseToken === 'string' && errorOrLeaseToken.trim()) {
      cleanToken = errorOrLeaseToken.trim();
      rawError = leaseTokenOrError;
    }

    if (!cleanToken) {
      logger.warn('[STORAGE_RECONCILIATION_FENCED] Missing or empty leaseToken in releaseTask rejected', {
        taskId,
        workerId,
      });
      return false;
    }

    const sanitizedErr = this.sanitizeError(rawError);
    const task = this.inMemoryCache.get(taskId);
    const newStatus: ReconciliationStatus =
      task && task.retryCount >= task.maxRetries ? 'FAILED' : 'PENDING';
    const pureWorkerId = workerId.includes(':') ? workerId.split(':')[0] : workerId;
    const expectedIdentity = `${pureWorkerId}:${cleanToken}`;

    const isIsolatedTestDb = Boolean(process.env.STORAGE_TEST_DATABASE_URL) || process.env.ISOLATED_TEST_DB === 'true';
    const shouldAccessDb = (prisma as any).storageReconciliation &&
      (process.env.NODE_ENV !== 'test' || isIsolatedTestDb);

    // 1. Database-level atomic fencing update
    if ((task?.storageTier === 'database' || !task) && shouldAccessDb) {
      try {
        const result = await (prisma as any).storageReconciliation.updateMany({
          where: {
            id: taskId,
            status: 'PROCESSING',
            lockedBy: expectedIdentity, // STRICT exact composite match only! NO startsWith!
          },
          data: {
            status: newStatus,
            lockedAt: null,
            lockedBy: null,
            lastError: sanitizedErr || null,
            updatedAt: new Date(),
          },
        });

        if (result.count === 0 && (task?.storageTier === 'database' || !task)) {
          logger.warn('[STORAGE_RECONCILIATION_FENCED] Stale worker attempt rejected in database releaseTask', {
            taskId,
            staleWorker: pureWorkerId,
            leaseToken: cleanToken,
          });
          return false;
        }
      } catch (err: any) {
        logger.warn('[STORAGE_RECONCILIATION] Failed to release task in database', {
          taskId,
          error: this.sanitizeError(err),
        });
      }
    }

    // 2. In-memory / fallback store fencing update
    if (task) {
      // Strict lease fencing check: must match exact composite lease identity and leaseToken
      if (task.lockedBy !== expectedIdentity || task.leaseToken !== cleanToken) {
        logger.warn('[STORAGE_RECONCILIATION_FENCED] In-memory stale worker lease rejected in releaseTask', {
          taskId,
          currentOwner: task.lockedBy,
          expectedOwner: expectedIdentity,
        });
        return false;
      }
      if (task.status !== 'PROCESSING') {
        logger.warn('[STORAGE_RECONCILIATION_FENCED] Stale worker attempt rejected: task not in PROCESSING', {
          taskId,
          status: task.status,
          staleWorker: pureWorkerId,
        });
        return false;
      }

      task.status = newStatus;
      task.lockedAt = null;
      task.lockedBy = null;
      task.leaseToken = null;
      task.lastError = sanitizedErr || null;
      task.updatedAt = new Date();
      if (this.allowDiskFallback) {
        this.flushToDisk();
      }
      return true;
    }

    return false;
  }

  /**
   * Marks a task as RESOLVED after successful reconciliation.
   * Strictly enforces worker lease fencing: validates lease identity so stale workers cannot resolve or overwrite newer state.
   * STRICT: Requires a valid, non-empty leaseToken matching the active claim.
   */
  async resolveTask(taskId: string, workerId: string, leaseToken: string): Promise<boolean> {
    if (!leaseToken || typeof leaseToken !== 'string' || !leaseToken.trim()) {
      logger.warn('[STORAGE_RECONCILIATION_FENCED] Missing or empty leaseToken in resolveTask rejected', {
        taskId,
        workerId,
      });
      return false;
    }

    const cleanToken = leaseToken.trim();
    const task = this.inMemoryCache.get(taskId);
    const pureWorkerId = workerId.includes(':') ? workerId.split(':')[0] : workerId;
    const expectedIdentity = `${pureWorkerId}:${cleanToken}`;

    const isIsolatedTestDb = Boolean(process.env.STORAGE_TEST_DATABASE_URL) || process.env.ISOLATED_TEST_DB === 'true';
    const shouldAccessDb = (prisma as any).storageReconciliation &&
      (process.env.NODE_ENV !== 'test' || isIsolatedTestDb);

    // 1. Database-level atomic fencing update
    if ((task?.storageTier === 'database' || !task) && shouldAccessDb) {
      try {
        const result = await (prisma as any).storageReconciliation.updateMany({
          where: {
            id: taskId,
            status: 'PROCESSING',
            lockedBy: expectedIdentity, // STRICT exact composite match only! NO startsWith!
          },
          data: {
            status: 'RESOLVED',
            lockedAt: null,
            lockedBy: null,
            lastError: null,
            updatedAt: new Date(),
          },
        });

        if (result.count === 0 && (task?.storageTier === 'database' || !task)) {
          logger.warn('[STORAGE_RECONCILIATION_FENCED] Stale worker lease rejected in database resolveTask', {
            taskId,
            staleWorker: pureWorkerId,
            leaseToken: cleanToken,
          });
          return false;
        }
      } catch (err: any) {
        logger.warn('[STORAGE_RECONCILIATION] Failed to update resolved state in database', {
          taskId,
          error: this.sanitizeError(err),
        });
      }
    }

    // 2. In-memory / fallback store fencing update
    if (task) {
      // Strict lease fencing check: must match exact composite lease identity and leaseToken
      if (task.lockedBy !== expectedIdentity || task.leaseToken !== cleanToken) {
        logger.warn('[STORAGE_RECONCILIATION_FENCED] In-memory stale worker lease rejected in resolveTask', {
          taskId,
          currentOwner: task.lockedBy,
          expectedOwner: expectedIdentity,
        });
        return false;
      }
      if (task.status !== 'PROCESSING') {
        logger.warn('[STORAGE_RECONCILIATION_FENCED] Stale worker attempt rejected: task not in PROCESSING', {
          taskId,
          status: task.status,
          staleWorker: pureWorkerId,
        });
        return false;
      }

      task.status = 'RESOLVED';
      task.lockedAt = null;
      task.lockedBy = null;
      task.leaseToken = null;
      task.lastError = null;
      task.updatedAt = new Date();
      if (this.allowDiskFallback) {
        this.flushToDisk();
      }
      return true;
    }

    return false;
  }

  /**
   * Returns all pending reconciliation tasks
   */
  getPendingTasks(): ReconciliationTask[] {
    return Array.from(this.inMemoryCache.values()).filter(
      (t) => t.status === 'PENDING'
    );
  }

  /**
   * Returns all stored tasks for auditing
   */
  getAllTasks(): ReconciliationTask[] {
    return Array.from(this.inMemoryCache.values());
  }

  /**
   * Executes reconciliation across pending and expired tasks.
   * Supports optional task scoping (taskIds or taskFilter) to guarantee test isolation.
   */
  async retryReconciliations(deps: {
    storageService: { deleteFile: (key: string) => Promise<void> };
    prisma: { learningResource: { delete: (args: any) => Promise<any> } };
    workerId?: string;
    force?: boolean;
    taskIds?: string[];
    taskFilter?: (task: ReconciliationTask) => boolean;
  }): Promise<{ succeeded: number; failed: number; skipped: number; fenced: number }> {
    const workerId = deps.workerId || `worker-${crypto.randomUUID()}`;
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    let fenced = 0;

    // Snapshot candidate IDs, optionally filtered for test isolation
    let taskIds = Array.from(this.inMemoryCache.keys());
    if (deps.taskIds && deps.taskIds.length > 0) {
      const allowedSet = new Set(deps.taskIds);
      taskIds = taskIds.filter((id) => allowedSet.has(id));
    }

    for (const taskId of taskIds) {
      const task = this.inMemoryCache.get(taskId);
      if (!task || task.status === 'RESOLVED' || task.status === 'FAILED') {
        continue;
      }

      if (deps.taskFilter && !deps.taskFilter(task)) {
        continue;
      }

      // Attempt atomic lease claim with unique fencing leaseToken
      const leaseToken = crypto.randomUUID();
      const claimed = await this.claimTask(taskId, workerId, { force: deps.force, leaseToken });
      if (!claimed) {
        skipped += 1;
        continue;
      }

      try {
        if (task.taskType === 'ORPHAN_STORAGE_KEY' && task.fileKey) {
          await deps.storageService.deleteFile(task.fileKey);
          const resolved = await this.resolveTask(taskId, workerId, leaseToken);
          if (resolved) {
            succeeded += 1;
            logger.info('[STORAGE_RECONCILIATION] Reconciled orphaned storage key', {
              taskId,
              fileKey: task.fileKey,
              workerId,
            });
          } else {
            fenced += 1;
            logger.warn('[STORAGE_RECONCILIATION] Worker fenced out after deleting file', {
              taskId,
              workerId,
            });
          }
        } else if (task.taskType === 'DANGLING_DB_RESOURCE' && task.resourceId) {
          try {
            await deps.prisma.learningResource.delete({
              where: { id: task.resourceId },
            });
          } catch (deleteErr: any) {
            if (deleteErr?.code !== 'P2025') {
              throw deleteErr;
            }
          }

          const resolved = await this.resolveTask(taskId, workerId, leaseToken);
          if (resolved) {
            succeeded += 1;
            logger.info('[STORAGE_RECONCILIATION] Reconciled dangling database record', {
              taskId,
              resourceId: task.resourceId,
              workerId,
            });
          } else {
            fenced += 1;
            logger.warn('[STORAGE_RECONCILIATION] Worker fenced out after deleting record', {
              taskId,
              workerId,
            });
          }
        }
      } catch (err: any) {
        const released = await this.releaseTask(taskId, workerId, err, leaseToken);
        if (released) {
          failed += 1;
        } else {
          fenced += 1;
        }
      }
    }

    return { succeeded, failed, skipped, fenced };
  }

  /**
   * Safely deletes specific tasks by ID (for scoped test teardowns without touching other records)
   */
  async deleteTasks(taskIds: string[]): Promise<number> {
    if (!taskIds || taskIds.length === 0) return 0;
    for (const id of taskIds) {
      this.inMemoryCache.delete(id);
    }
    if (this.allowDiskFallback) {
      this.flushToDisk();
    }
    const isIsolatedTestDb = Boolean(process.env.STORAGE_TEST_DATABASE_URL) || process.env.ISOLATED_TEST_DB === 'true';
    const shouldAccessDb = (prisma as any).storageReconciliation &&
      (process.env.NODE_ENV !== 'test' || isIsolatedTestDb);

    if (shouldAccessDb) {
      try {
        const result = await (prisma as any).storageReconciliation.deleteMany({
          where: { id: { in: taskIds } },
        });
        return result.count;
      } catch {
        return 0;
      }
    }
    return taskIds.length;
  }

  /**
   * Resets all in-memory and disk records (test fixture cleanup)
   */
  clear(): void {
    this.inMemoryCache.clear();
    try {
      if (this.filePath && fs.existsSync(this.filePath)) {
        fs.unlinkSync(this.filePath);
      }
    } catch {
      // Ignored
    }
  }
}

export const storageReconciliation = new StorageReconciliationService();
