-- Migration: 20261106_add_storage_reconciliation
-- Description: Adds storage_reconciliations table for Cloudflare R2 storage reconciliation
-- Safety: Fully additive. Does not alter, drop, or lock any existing tables.

-- CreateEnum
CREATE TYPE "ReconciliationTaskType" AS ENUM ('ORPHAN_STORAGE_KEY', 'DANGLING_DB_RESOURCE');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('PENDING', 'PROCESSING', 'RESOLVED', 'FAILED');

-- CreateTable
CREATE TABLE "storage_reconciliations" (
    "id" TEXT NOT NULL,
    "task_type" "ReconciliationTaskType" NOT NULL,
    "file_key" TEXT,
    "resource_id" TEXT,
    "status" "ReconciliationStatus" NOT NULL DEFAULT 'PENDING',
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "max_retries" INTEGER NOT NULL DEFAULT 5,
    "last_error" TEXT,
    "locked_at" TIMESTAMP(3),
    "locked_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storage_reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "storage_reconciliations_status_retry_count_idx" ON "storage_reconciliations"("status", "retry_count");

-- CreateIndex
CREATE INDEX "storage_reconciliations_file_key_idx" ON "storage_reconciliations"("file_key");

-- CreateIndex
CREATE INDEX "storage_reconciliations_resource_id_idx" ON "storage_reconciliations"("resource_id");

