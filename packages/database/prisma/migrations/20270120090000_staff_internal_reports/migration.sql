-- AlterTable
ALTER TABLE "staff_manager_notes" ADD COLUMN "title" TEXT,
ADD COLUMN "category" TEXT NOT NULL DEFAULT 'NOTE',
ADD COLUMN "warningId" TEXT;

-- AlterTable
ALTER TABLE "staff_server_links" ADD COLUMN "internalReportChannelId" TEXT;
