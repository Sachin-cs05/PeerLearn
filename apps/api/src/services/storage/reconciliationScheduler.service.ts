import crypto from 'node:crypto';
import { prisma } from '../../config/prisma.js';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { storageService } from '../storage.service.js';
import {
  storageReconciliation,
  StorageReconciliationService,
} from './reconciliation.service.js';

export interface ReconciliationSchedulerOptions {
  enabled?: boolean;
  intervalMs?: number;
  initialDelayMs?: number;
  workerId?: string;
  reconciliationService?: StorageReconciliationService;
  storageServiceDep?: typeof storageService;
  prismaDep?: typeof prisma;
  forceEnableInTest?: boolean;
}

export class ReconciliationScheduler {
  private timer: NodeJS.Timeout | null = null;
  private initialTimeout: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private isShuttingDown: boolean = false;
  private activeExecutionPromise: Promise<void> | null = null;

  public readonly workerId: string;
  public readonly intervalMs: number;
  public readonly initialDelayMs: number;
  public readonly enabled: boolean;

  private readonly reconciliationService: StorageReconciliationService;
  private readonly storageServiceDep: typeof storageService;
  private readonly prismaDep: typeof prisma;

  constructor(options?: ReconciliationSchedulerOptions) {
    this.workerId =
      options?.workerId ||
      `worker-reconcile-${process.pid || 'main'}-${crypto.randomUUID().slice(0, 8)}`;

    const configEnabled =
      typeof options?.enabled === 'boolean'
        ? options.enabled
        : (env.STORAGE_RECONCILIATION_ENABLED ?? true);

    // In test environment, disable by default unless explicitly forced
    if (process.env.NODE_ENV === 'test' && !options?.forceEnableInTest) {
      this.enabled = false;
    } else {
      this.enabled = configEnabled;
    }

    const interval = options?.intervalMs ?? env.STORAGE_RECONCILIATION_INTERVAL_MS ?? 60000;
    this.intervalMs = Math.max(1000, interval);
    this.initialDelayMs = options?.initialDelayMs ?? 10000;

    this.reconciliationService = options?.reconciliationService || storageReconciliation;
    this.storageServiceDep = options?.storageServiceDep || storageService;
    this.prismaDep = options?.prismaDep || prisma;
  }

  /**
   * Starts the reconciliation scheduler.
   * Handles duplicate registration and explicit disable configuration.
   */
  start(): void {
    if (this.timer || this.initialTimeout) {
      logger.warn(
        '[STORAGE_RECONCILIATION_WORKER] Reconciliation scheduler is already registered. Duplicate start ignored.',
        { workerId: this.workerId }
      );
      return;
    }

    if (!this.enabled) {
      logger.info(
        '[STORAGE_RECONCILIATION_WORKER] Reconciliation scheduler is disabled via configuration.',
        { workerId: this.workerId }
      );
      return;
    }

    this.isShuttingDown = false;
    logger.info('[STORAGE_RECONCILIATION_WORKER] Worker started', {
      workerId: this.workerId,
      intervalMs: this.intervalMs,
      initialDelayMs: this.initialDelayMs,
    });

    // Initial run after brief delay to allow server and database handshake
    this.initialTimeout = setTimeout(() => {
      this.initialTimeout = null;
      if (!this.isShuttingDown) {
        this.runCycle().catch((err) => {
          logger.error('[STORAGE_RECONCILIATION_WORKER_ERROR] Initial cycle failed', {
            workerId: this.workerId,
            error: err?.message || String(err),
          });
        });
      }
    }, this.initialDelayMs);

    // Recurring execution interval
    this.timer = setInterval(() => {
      if (!this.isShuttingDown) {
        this.runCycle().catch((err) => {
          logger.error('[STORAGE_RECONCILIATION_WORKER_ERROR] Scheduled cycle failed', {
            workerId: this.workerId,
            error: err?.message || String(err),
          });
        });
      }
    }, this.intervalMs);
  }

  /**
   * Runs a single reconciliation cycle with in-process overlap protection and structured metrics logging.
   */
  async runCycle(): Promise<{
    executed: boolean;
    tasksClaimed?: number;
    tasksResolved?: number;
    tasksRetried?: number;
    tasksFailed?: number;
    tasksFenced?: number;
    tasksSkipped?: number;
  }> {
    if (this.isShuttingDown) {
      return { executed: false };
    }

    // Overlap prevention mutex
    if (this.isRunning) {
      logger.info(
        '[STORAGE_RECONCILIATION_WORKER] Previous reconciliation cycle still active; skipping overlapping execution.',
        { workerId: this.workerId }
      );
      return { executed: false };
    }

    this.isRunning = true;
    const executionPromise = (async () => {
      try {
        const result = await this.reconciliationService.retryReconciliations({
          storageService: this.storageServiceDep,
          prisma: this.prismaDep,
          workerId: this.workerId,
        });

        const tasksClaimed = result.succeeded + result.failed + result.fenced;
        const tasksRetried = tasksClaimed;

        // Structured metrics logging
        if (tasksClaimed > 0 || result.skipped > 0) {
          logger.info('[STORAGE_RECONCILIATION_CYCLE_COMPLETED]', {
            workerId: this.workerId,
            tasksClaimed,
            tasksResolved: result.succeeded,
            tasksRetried,
            tasksFailed: result.failed,
            tasksFenced: result.fenced,
            tasksSkipped: result.skipped,
          });
        }

        return {
          executed: true,
          tasksClaimed,
          tasksResolved: result.succeeded,
          tasksRetried,
          tasksFailed: result.failed,
          tasksFenced: result.fenced,
          tasksSkipped: result.skipped,
        };
      } catch (err: any) {
        logger.error('[STORAGE_RECONCILIATION_WORKER_ERROR]', {
          workerId: this.workerId,
          error: err?.message || String(err),
        });
        return { executed: false };
      } finally {
        this.isRunning = false;
        this.activeExecutionPromise = null;
      }
    })();

    this.activeExecutionPromise = executionPromise.then(() => {});
    return await executionPromise;
  }

  /**
   * Gracefully shuts down the scheduler, clearing timers and waiting for any active in-flight cycle.
   */
  async stop(): Promise<void> {
    if (this.isShuttingDown && !this.timer && !this.initialTimeout) {
      return;
    }

    this.isShuttingDown = true;

    if (this.initialTimeout) {
      clearTimeout(this.initialTimeout);
      this.initialTimeout = null;
    }

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.activeExecutionPromise) {
      try {
        await this.activeExecutionPromise;
      } catch {
        // Ignored during shutdown
      }
    }

    logger.info('[STORAGE_RECONCILIATION_WORKER] Worker stopped', {
      workerId: this.workerId,
    });
  }

  /**
   * Returns whether the scheduler is currently active.
   */
  isRunningState(): boolean {
    return this.isRunning;
  }

  /**
   * Returns whether the scheduler is registered and armed with a timer.
   */
  isScheduled(): boolean {
    return this.timer !== null || this.initialTimeout !== null;
  }
}

// Global singleton instance
export const reconciliationScheduler = new ReconciliationScheduler();

export function startReconciliationScheduler(options?: ReconciliationSchedulerOptions): void {
  if (options) {
    const customScheduler = new ReconciliationScheduler(options);
    customScheduler.start();
    return;
  }
  reconciliationScheduler.start();
}

export async function stopReconciliationScheduler(): Promise<void> {
  await reconciliationScheduler.stop();
}

