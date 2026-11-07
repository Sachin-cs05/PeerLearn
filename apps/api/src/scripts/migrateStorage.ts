import path from 'node:path';
import { storageMigrationService } from '../services/storage/migration/migration.service.js';
import { logger } from '../utils/logger.js';

async function main() {
  const args = process.argv.slice(2);
  const isExecute = args.includes('--execute');
  const dryRun = !isExecute;

  console.log('===============================================================');
  console.log(`PeerLearn Cloudflare R2 Storage Migration Tool`);
  console.log(`Mode: ${dryRun ? 'DRY-RUN (Safe Read-Only)' : 'LIVE EXECUTION'}`);
  console.log('===============================================================\n');

  try {
    const rootDir = process.cwd().endsWith('api')
      ? path.resolve(process.cwd(), '../..')
      : process.cwd();
    const rootReportPath = path.resolve(rootDir, 'PHASE_2_3_MIGRATION_DRY_RUN_REPORT.md');

    const result = await storageMigrationService.runMigration({
      dryRun,
      reportPath: rootReportPath,
    });

    console.log('\n--- Migration Inventory Summary ---');
    console.log(`Total Database Records:      ${result.inventory.totalDbRecords}`);
    console.log(`Total Local Files:           ${result.inventory.totalLocalFiles}`);
    console.log(`Eligible for Migration:      ${result.inventory.eligibleFiles}`);
    console.log(`Missing on Local Disk:       ${result.inventory.missingLocalFiles}`);
    console.log(`Orphan Local Files:          ${result.inventory.orphanLocalFiles}`);
    console.log(`Already Migrated:            ${result.inventory.alreadyMigratedFiles}`);
    console.log(`Duplicate Content Files:     ${result.inventory.duplicateFiles}`);
    console.log(`Unsupported Format Files:    ${result.inventory.unsupportedFiles}`);
    console.log(`Total Eligible Data Size:    ${Math.round(result.inventory.totalEligibleSizeBytes / 1024)} KB`);
    console.log(`Report Generated at:         ${rootReportPath}`);
    console.log('------------------------------------\n');

    if (result.inventory.warnings.length > 0) {
      console.log('Warnings:');
      for (const w of result.inventory.warnings) {
        console.log(` [!] ${w}`);
      }
      console.log('');
    }

    if (dryRun) {
      console.log('DRY-RUN COMPLETE: Zero files modified, zero R2 uploads, zero database updates.');
      console.log('Awaiting user review and approval before live migration.');
    }
  } catch (error: any) {
    logger.error('[CLI] Migration failed with error', { error: error.message });
    console.error('Migration failed:', error.message);
    process.exit(1);
  }
}

main();
