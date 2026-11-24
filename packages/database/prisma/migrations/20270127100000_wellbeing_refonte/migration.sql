-- AlterTable
ALTER TABLE "wellbeing_configs" ADD COLUMN "alertChannelId" TEXT,
ADD COLUMN "alertUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "alertEvents" TEXT[] DEFAULT ARRAY['BREAK_GLASS', 'EMERGENCY_READ', 'CONFIG_CHANGE', 'REPORT', 'REMINDER']::TEXT[],
ADD COLUMN "breakGlassApproval" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "reportEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "staleCriticalDays" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN "resources" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "wellbeing_cases" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'DASHBOARD',
ADD COLUMN "assigneeId" TEXT,
ADD COLUMN "reviewAt" TIMESTAMP(3),
ADD COLUMN "reviewRemindedAt" TIMESTAMP(3),
ADD COLUMN "staleRemindedAt" TIMESTAMP(3),
ADD COLUMN "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Les dossiers existants repartent de leur dernière modification connue.
UPDATE "wellbeing_cases" SET "lastActivityAt" = "updatedAt";

-- AlterTable
ALTER TABLE "wellbeing_break_glass_logs" ADD COLUMN "subjectUserId" TEXT,
ADD COLUMN "status" TEXT NOT NULL DEFAULT 'APPROVED',
ADD COLUMN "approvedById" TEXT,
ADD COLUMN "approvedByName" TEXT,
ADD COLUMN "decidedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "wellbeing_case_events" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wellbeing_case_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wellbeing_case_events_caseId_createdAt_idx" ON "wellbeing_case_events"("caseId", "createdAt");

-- CreateIndex
CREATE INDEX "wellbeing_cases_status_reviewAt_idx" ON "wellbeing_cases"("status", "reviewAt");

-- AddForeignKey
ALTER TABLE "wellbeing_case_events" ADD CONSTRAINT "wellbeing_case_events_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "wellbeing_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
