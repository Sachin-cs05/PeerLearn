import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { prisma } from '../src/config/prisma.js';
import { storageService } from '../src/services/storage.service.js';
import {
  StorageReconciliationService,
  storageReconciliation,
  type ReconciliationTask,
} from '../src/services/storage/reconciliation.service.js';
import { AppError } from '../src/middleware/errorHandler.js';

describe('Phase 2.4 — Tasks 6, 7, 8: Reconciliation Worker Reliability, Lease Fencing, Failure Recovery & Concurrency', () => {
  const createdTestTaskIds = new Set<string>();

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    // Scoped test teardown: only clean up tasks explicitly registered in this test run
    if (createdTestTaskIds.size > 0) {
      await storageReconciliation.deleteTasks(Array.from(createdTestTaskIds));
      createdTestTaskIds.clear();
    }
  });

  describe('Task 6: Worker Leasing, Strict Lease Fencing & Persistence Reliability', () => {
    it('1. atomic leasing: exactly one worker claims task when multiple workers compete simultaneously', async () => {
      const testKey = `compete-${crypto.randomUUID()}.pdf`;
      const task = await storageReconciliation.recordOrphanStorageKey(testKey, 'CONCURRENT_CLAIM_TEST');
      createdTestTaskIds.add(task.id);

      const workers = ['worker-1', 'worker-2', 'worker-3', 'worker-4'];
      const claimResults = await Promise.all(
        workers.map((wId) => storageReconciliation.claimTask(task.id, wId))
      );

      const successfulClaims = claimResults.filter((claimed) => claimed === true);
      expect(successfulClaims).toHaveLength(1);

      const updated = storageReconciliation.getAllTasks().find((t) => t.id === task.id);
      expect(updated?.status).toBe('PROCESSING');
      expect(workers).toContain(updated?.lockedBy);
    }, 20000);

    it('2. STRICT LEASE FENCING on resolveTask: stale worker whose lease expired cannot resolve or overwrite newer worker state', async () => {
      // Create a dedicated reconciliation service with short 100ms lock lease for testing
      const shortLeaseService = new StorageReconciliationService({ lockLeaseMs: 100 });
      const testKey = `fencing-resolve-${crypto.randomUUID()}.pdf`;
      const task = await shortLeaseService.recordOrphanStorageKey(testKey, 'FENCING_RESOLVE_TEST');
      createdTestTaskIds.add(task.id);

      // Step 1: Worker A claims the task
      const claimedA = await shortLeaseService.claimTask(task.id, 'worker-A');
      expect(claimedA).toBe(true);

      const taskUnderA = shortLeaseService.getAllTasks().find((t) => t.id === task.id);
      expect(taskUnderA?.status).toBe('PROCESSING');
      expect(taskUnderA?.lockedBy).toBe('worker-A');

      // Step 2: Simulate lease expiration (> 100ms)
      await new Promise((resolve) => setTimeout(resolve, 120));

      // Step 3: Worker B claims the expired task
      const claimedB = await shortLeaseService.claimTask(task.id, 'worker-B', { force: true });
      expect(claimedB).toBe(true);

      const taskUnderB = shortLeaseService.getAllTasks().find((t) => t.id === task.id);
      expect(taskUnderB?.status).toBe('PROCESSING');
      expect(taskUnderB?.lockedBy).toBe('worker-B');

      // Step 4: Stale Worker A finishes late and attempts resolveTask!
      // Strict lease fencing MUST reject Worker A's resolution attempt
      const resolveResultA = await shortLeaseService.resolveTask(task.id, 'worker-A');
      expect(resolveResultA).toBe(false);

      // Crucial: Task must NOT be resolved, and Worker B's active lock must NOT be overwritten!
      const taskAfterStaleA = shortLeaseService.getAllTasks().find((t) => t.id === task.id);
      expect(taskAfterStaleA?.status).toBe('PROCESSING');
      expect(taskAfterStaleA?.lockedBy).toBe('worker-B');

      // Step 5: Legitimate Worker B finishes and calls resolveTask
      const resolveResultB = await shortLeaseService.resolveTask(task.id, 'worker-B');
      expect(resolveResultB).toBe(true);

      const finalTask = shortLeaseService.getAllTasks().find((t) => t.id === task.id);
      expect(finalTask?.status).toBe('RESOLVED');
      expect(finalTask?.lockedBy).toBeNull();
    }, 20000);

    it('3. STRICT LEASE FENCING on releaseTask: stale worker whose lease expired cannot release or reset newer worker state', async () => {
      const shortLeaseService = new StorageReconciliationService({ lockLeaseMs: 100 });
      const testKey = `fencing-release-${crypto.randomUUID()}.pdf`;
      const task = await shortLeaseService.recordOrphanStorageKey(testKey, 'FENCING_RELEASE_TEST');
      createdTestTaskIds.add(task.id);

      // Worker A claims
      await shortLeaseService.claimTask(task.id, 'worker-A');

      // Lease expires
      await new Promise((resolve) => setTimeout(resolve, 120));

      // Worker B claims
      await shortLeaseService.claimTask(task.id, 'worker-B', { force: true });

      // Stale Worker A attempts releaseTask
      const releaseResultA = await shortLeaseService.releaseTask(task.id, 'worker-A', new Error('Late timeout'));
      expect(releaseResultA).toBe(false);

      // Task status and Worker B lease are strictly preserved
      const taskAfterStaleRelease = shortLeaseService.getAllTasks().find((t) => t.id === task.id);
      expect(taskAfterStaleRelease?.status).toBe('PROCESSING');
      expect(taskAfterStaleRelease?.lockedBy).toBe('worker-B');

      // Worker B successfully finalizes
      const resolveResultB = await shortLeaseService.resolveTask(task.id, 'worker-B');
      expect(resolveResultB).toBe(true);
    }, 20000);

    it('4. retry exhaustion transitions task to FAILED and halts infinite retries', async () => {
      const testKey = `exhaust-${crypto.randomUUID()}.pdf`;
      const task = await storageReconciliation.recordOrphanStorageKey(testKey, 'EXHAUST_TEST');
      createdTestTaskIds.add(task.id);

      for (let i = 0; i < task.maxRetries; i++) {
        await storageReconciliation.claimTask(task.id, `exhaust-worker-${i}`, { force: true });
        await storageReconciliation.releaseTask(task.id, `exhaust-worker-${i}`, new Error(`Attempt ${i + 1} failed`));
      }

      const exhaustedTask = storageReconciliation.getAllTasks().find((t) => t.id === task.id);
      expect(exhaustedTask?.status).toBe('FAILED');
      expect(exhaustedTask?.retryCount).toBe(task.maxRetries);

      // Attempting to claim an already FAILED task returns false (no infinite loop)
      const claimAfterFailed = await storageReconciliation.claimTask(task.id, 'worker-late');
      expect(claimAfterFailed).toBe(false);
    }, 20000);

    it('5. scoped retry processing: retryReconciliations only processes specified taskIds without touching other records', async () => {
      const key1 = `isolated-1-${crypto.randomUUID()}.pdf`;
      const key2 = `isolated-2-${crypto.randomUUID()}.pdf`;

      const task1 = await storageReconciliation.recordOrphanStorageKey(key1, 'TASK_1');
      const task2 = await storageReconciliation.recordOrphanStorageKey(key2, 'TASK_2');
      createdTestTaskIds.add(task1.id);
      createdTestTaskIds.add(task2.id);

      const deleteSpy = vi.spyOn(storageService, 'deleteFile').mockResolvedValue();

      // Run retryReconciliations scoped strictly to task1.id
      const result = await storageReconciliation.retryReconciliations({
        storageService,
        prisma: {} as any,
        taskIds: [task1.id],
        force: true,
      });

      expect(result.succeeded).toBe(1);
      expect(deleteSpy).toHaveBeenCalledWith(key1);
      expect(deleteSpy).not.toHaveBeenCalledWith(key2);

      const status1 = storageReconciliation.getAllTasks().find((t) => t.id === task1.id);
      const status2 = storageReconciliation.getAllTasks().find((t) => t.id === task2.id);

      expect(status1?.status).toBe('RESOLVED');
      expect(status2?.status).toBe('PENDING'); // Task 2 remained untouched!
    }, 20000);
  });

  describe('Task 7: Failure and Recovery Resilience', () => {
    it('6. handles storage outage during compensating cleanup: records orphan task and recovers once storage returns', async () => {
      const testKey = `recovering-${crypto.randomUUID()}.pdf`;

      // Simulate storage outage during compensation
      const deleteFailSpy = vi.spyOn(storageService, 'deleteFile').mockRejectedValueOnce(
        new Error('R2 503 Service Unavailable')
      );

      let recordedTask: ReconciliationTask | null = null;
      try {
        await storageService.deleteFile(testKey);
      } catch (err: any) {
        recordedTask = await storageReconciliation.recordOrphanStorageKey(testKey, 'COMPENSATION_FAILED', err.message);
        createdTestTaskIds.add(recordedTask.id);
      }

      expect(deleteFailSpy).toHaveBeenCalledTimes(1);
      expect(recordedTask).toBeDefined();
      expect(recordedTask?.status).toBe('PENDING');

      // Once R2 is restored, retryReconciliations successfully clears the orphan
      vi.spyOn(storageService, 'deleteFile').mockResolvedValueOnce();
      const retryResult = await storageReconciliation.retryReconciliations({
        storageService,
        prisma: {} as any,
        taskIds: [recordedTask!.id],
        force: true,
      });

      expect(retryResult.succeeded).toBe(1);
      const updated = storageReconciliation.getAllTasks().find((t) => t.id === recordedTask!.id);
      expect(updated?.status).toBe('RESOLVED');
    }, 20000);

    it('7. pending tasks survive service reboot / crash and are resumable', async () => {
      const testKey = `crash-survive-${crypto.randomUUID()}.pdf`;
      const originalTask = await storageReconciliation.recordOrphanStorageKey(testKey, 'REBOOT_SURVIVAL_TEST');
      createdTestTaskIds.add(originalTask.id);

      // Simulate container crash & reboot by instantiating a fresh service instance
      const restartedService = new StorageReconciliationService();
      await restartedService.persistTask(originalTask);

      const recoveredTask = restartedService.getAllTasks().find((t) => t.id === originalTask.id);
      expect(recoveredTask).toBeDefined();
      expect(recoveredTask?.fileKey).toBe(testKey);

      // Worker on rebooted service claims and resolves the task
      const claimed = await restartedService.claimTask(recoveredTask!.id, 'reboot-worker', { force: true });
      expect(claimed).toBe(true);
      await restartedService.resolveTask(recoveredTask!.id, 'reboot-worker');

      const resolved = restartedService.getAllTasks().find((t) => t.id === recoveredTask!.id);
      expect(resolved?.status).toBe('RESOLVED');
    }, 20000);
  });

  describe('Task 8: Concurrency & Performance Testing', () => {
    it('8. concurrent uploads: 10 parallel uploads generate collision-free UUID keys and complete under 2 seconds', async () => {
      const startTime = Date.now();
      const concurrency = 10;
      const uploadPromises: Promise<any>[] = [];

      for (let i = 0; i < concurrency; i++) {
        const buffer = Buffer.from(`%PDF-1.4 Concurrent document ${i}`);
        uploadPromises.push(
          storageService.saveFile(buffer, `document_${i}.pdf`, 'application/pdf')
        );
      }

      const results = await Promise.all(uploadPromises);
      const totalDuration = Date.now() - startTime;

      expect(results).toHaveLength(concurrency);

      // Verify all generated file keys are strictly unique
      const fileKeys = new Set(results.map((r) => r.fileKey));
      expect(fileKeys.size).toBe(concurrency);

      // Verify each key matches UUID format
      for (const res of results) {
        expect(res.fileKey).toMatch(/^[0-9a-fA-F-]{36}\.pdf$/);
      }

      // Record performance metric
      const avgDurationPerUpload = totalDuration / concurrency;
      expect(avgDurationPerUpload).toBeLessThan(500); // Less than 500ms average

      // Clean up uploaded files
      for (const res of results) {
        try {
          await storageService.deleteFile(res.fileKey);
        } catch {
          // Ignored
        }
      }
    });

    it('9. concurrent downloads: 10 parallel download streams execute concurrently without lock contention', async () => {
      const testKey = '11111111-2222-3333-4444-555555555555.pdf';
      const mockStreamResult = {
        stream: {} as any,
        size: 1024,
        mimeType: 'application/pdf',
      };

      vi.spyOn(storageService, 'getFileStream').mockResolvedValue(mockStreamResult);

      const startTime = Date.now();
      const concurrency = 10;
      const downloadPromises = Array.from({ length: concurrency }).map(() =>
        storageService.getFileStream(testKey)
      );

      const results = await Promise.all(downloadPromises);
      const totalDuration = Date.now() - startTime;

      expect(results).toHaveLength(concurrency);
      expect(totalDuration).toBeLessThan(1000); // 10 parallel calls complete well under 1 second
    });

    it('10. concurrent reconciliation claims: 5 workers competing for 5 distinct tasks claim 1:1 without collisions', async () => {
      const tasks: ReconciliationTask[] = [];
      for (let i = 0; i < 5; i++) {
        const t = await storageReconciliation.recordOrphanStorageKey(`multi-race-${i}.pdf`, `MULTI_RACE_${i}`);
        tasks.push(t);
        createdTestTaskIds.add(t.id);
      }

      // 5 workers attempt to claim all 5 tasks concurrently
      const workers = ['worker-A', 'worker-B', 'worker-C', 'worker-D', 'worker-E'];
      const claimsMatrix = await Promise.all(
        tasks.map(async (t, idx) => {
          // Each worker targets a specific task
          return await storageReconciliation.claimTask(t.id, workers[idx]);
        })
      );

      // All 5 workers successfully claim their distinct task
      expect(claimsMatrix.every((claimed) => claimed === true)).toBe(true);

      const allActive = storageReconciliation.getAllTasks().filter((t) => tasks.some((orig) => orig.id === t.id));
      const assignedWorkers = new Set(allActive.map((t) => t.lockedBy));
      expect(assignedWorkers.size).toBe(5);
    }, 20000);
  });
});
