export type FileRecordStatus =
  | 'ELIGIBLE'
  | 'MISSING_ON_DISK'
  | 'ORPHAN_ON_DISK'
  | 'ALREADY_MIGRATED'
  | 'DUPLICATE_CONTENT'
  | 'UNSUPPORTED_FORMAT';

export interface InventoryItem {
  fileKey: string;
  resourceId: string | null;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number;
  localPath: string | null;
  sha256: string | null;
  status: FileRecordStatus;
  duplicateOf?: string;
  reason?: string;
}

export interface StorageInventoryReport {
  scannedAt: Date;
  legacyDirectories: string[];
  totalDbRecords: number;
  totalLocalFiles: number;
  eligibleFiles: number;
  missingLocalFiles: number;
  orphanLocalFiles: number;
  alreadyMigratedFiles: number;
  duplicateFiles: number;
  unsupportedFiles: number;
  totalEligibleSizeBytes: number;
  items: InventoryItem[];
  warnings: string[];
  recommendedActions: string[];
}

export interface MigrationOptions {
  dryRun?: boolean;
  batchSize?: number;
  concurrency?: number;
  legacyDirs?: string[];
  reportPath?: string;
  prismaClient?: any;
}

export interface MigrationResult {
  dryRun: boolean;
  inventory: StorageInventoryReport;
  migratedCount: number;
  failedCount: number;
  skippedCount: number;
  errors: Array<{ fileKey: string; error: string }>;
  durationMs: number;
}
