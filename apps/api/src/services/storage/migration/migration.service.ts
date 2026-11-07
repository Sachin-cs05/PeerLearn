import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../../utils/logger.js';
import { prisma as defaultPrisma } from '../../../config/prisma.js';
import { storageService } from '../../storage.service.js';
import { storageInventoryService } from './inventory.service.js';
import type {
  MigrationOptions,
  MigrationResult,
  StorageInventoryReport,
} from './migration.types.js';

export class StorageMigrationService {
  /**
   * Generates a clean markdown report from an inventory scan
   */
  public generateMarkdownReport(
    inventory: StorageInventoryReport,
    options?: { dryRun?: boolean; result?: MigrationResult }
  ): string {
    const isDryRun = options?.dryRun ?? true;
    const modeTitle = isDryRun ? 'DRY-RUN EXECUTION (READ-ONLY)' : 'LIVE MIGRATION EXECUTION';

    const lines: string[] = [];
    lines.push(`# Phase 2.3 — Storage Migration to Cloudflare R2`);
    lines.push(`## ${modeTitle} Report\n`);
    lines.push(`**Project:** PeerLearn — Learn Together. Grow Together.  `);
    lines.push(`**Execution Mode:** ${isDryRun ? 'Dry-Run (Zero Writes, Zero Side Effects)' : 'Live Execution'}  `);
    lines.push(`**Timestamp:** ${inventory.scannedAt.toISOString()}  `);
    lines.push(`**Scanned Legacy Directories:**\n`);
    for (const d of inventory.legacyDirectories) {
      lines.push(`- \`${d}\``);
    }
    lines.push(`\n---\n`);

    lines.push(`## 1. Inventory Summary Metrics\n`);
    lines.push(`| Metric | Value | Description |`);
    lines.push(`| :--- | :---: | :--- |`);
    lines.push(`| **Total DB File Records** | **${inventory.totalDbRecords}** | \`LearningResource\` records referencing a \`fileKey\` |`);
    lines.push(`| **Total Local Files** | **${inventory.totalLocalFiles}** | Physical files discovered across legacy upload folders |`);
    lines.push(`| **Eligible for Migration** | **${inventory.eligibleFiles}** | Valid files matched between database and local disk |`);
    lines.push(`| **Missing on Local Disk** | **${inventory.missingLocalFiles}** | Referenced in DB but missing on disk (ephemeral disk restart) |`);
    lines.push(`| **Orphan Local Files** | **${inventory.orphanLocalFiles}** | Local files on disk with no database record reference |`);
    lines.push(`| **Already Migrated to R2** | **${inventory.alreadyMigratedFiles}** | Files already verified in Cloudflare R2 storage |`);
    lines.push(`| **Duplicate Content Files** | **${inventory.duplicateFiles}** | Files sharing identical SHA-256 hash |`);
    lines.push(`| **Unsupported Format Files** | **${inventory.unsupportedFiles}** | Files failing extension or magic-byte signature check |`);
    lines.push(`| **Total Eligible Data Size** | **${Math.round(inventory.totalEligibleSizeBytes / 1024)} KB** | Total bytes eligible for R2 transmission |`);

    lines.push(`\n---\n`);

    lines.push(`## 2. Warnings & Recommended Actions\n`);
    if (inventory.warnings.length === 0) {
      lines.push(`> [!NOTE] No anomalies or integrity warnings detected during scan.\n`);
    } else {
      for (const w of inventory.warnings) {
        lines.push(`> [!WARNING] ${w}`);
      }
      lines.push(``);
    }

    lines.push(`### Recommended Actions:`);
    for (const action of inventory.recommendedActions) {
      lines.push(`- ${action}`);
    }

    lines.push(`\n---\n`);

    lines.push(`## 3. Detailed Per-File Inventory Assessment\n`);
    if (inventory.items.length === 0) {
      lines.push(`*No files discovered in database or local storage.*`);
    } else {
      lines.push(`| File Key | Resource ID | Status | Size | SHA-256 | Notes / Reason |`);
      lines.push(`| :--- | :--- | :---: | :---: | :---: | :--- |`);
      for (const item of inventory.items) {
        const shortSha = item.sha256 ? `\`${item.sha256.substring(0, 8)}...\`` : '-';
        const resId = item.resourceId ? `\`${item.resourceId}\`` : '-';
        const notes = item.duplicateOf
          ? `Duplicate of \`${item.duplicateOf}\``
          : item.reason || 'Ready for migration';
        lines.push(
          `| \`${item.fileKey}\` | ${resId} | **${item.status}** | ${item.sizeBytes} B | ${shortSha} | ${notes} |`
        );
      }
    }

    lines.push(`\n---\n`);

    lines.push(`## 4. Safety & Operational Invariants`);
    lines.push(`1. **Original Files Retained:** No local files were deleted or modified during this execution.`);
    lines.push(`2. **Zero Database Modifications:** Database records remain untouched in dry-run mode.`);
    lines.push(`3. **Zero R2 Transmissions:** No network requests were dispatched to Cloudflare R2 bucket.`);
    lines.push(`4. **Phase Gate:** Live migration requires explicit user authorization before execution.`);

    return lines.join('\n');
  }

  /**
   * Executes the migration in dry-run or live mode
   */
  async runMigration(options?: MigrationOptions): Promise<MigrationResult> {
    const isDryRun = options?.dryRun ?? true;
    const startTime = Date.now();

    logger.info(`[STORAGE_MIGRATION] Initiating storage migration (mode: ${isDryRun ? 'DRY-RUN' : 'LIVE'})`);

    // Perform complete inventory scan
    const inventory = await storageInventoryService.scanInventory({
      legacyDirs: options?.legacyDirs,
      prismaClient: options?.prismaClient,
      r2Provider: storageService.isCloudStorage() ? storageService.getProvider() : undefined,
    });

    const reportContent = this.generateMarkdownReport(inventory, { dryRun: isDryRun });

    // Save report to disk if report path provided or to default root path
    const reportPath =
      options?.reportPath || path.resolve(process.cwd(), 'PHASE_2_3_MIGRATION_DRY_RUN_REPORT.md');

    try {
      await fs.promises.writeFile(reportPath, reportContent, 'utf-8');
      logger.info('[STORAGE_MIGRATION] Dry-run report written to file', { reportPath });
    } catch (err: any) {
      logger.warn('[STORAGE_MIGRATION] Could not write dry-run report file', {
        error: err.message,
      });
    }

    if (isDryRun) {
      // In dry-run mode: strictly return results without touching DB or R2
      return {
        dryRun: true,
        inventory,
        migratedCount: 0,
        failedCount: 0,
        skippedCount: inventory.items.length - inventory.eligibleFiles,
        errors: [],
        durationMs: Date.now() - startTime,
      };
    }

    // Live migration logic will execute only after phase gate approval
    throw new Error('Live migration requires explicit post-dry-run user authorization');
  }
}

export const storageMigrationService = new StorageMigrationService();
