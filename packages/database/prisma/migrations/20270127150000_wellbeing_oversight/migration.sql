-- Revue périodique des accès de la cellule bien-être.
ALTER TABLE "wellbeing_configs" ADD COLUMN "accessReviewedAt" TIMESTAMP(3),
ADD COLUMN "accessReviewSentAt" TIMESTAMP(3);

-- L'annonce d'effacement des dossiers fermés est cochée par défaut, y compris
-- sur les cellules déjà configurées : elle se retire ensuite si on n'en veut pas.
ALTER TABLE "wellbeing_configs" ALTER COLUMN "alertEvents" SET DEFAULT ARRAY['BREAK_GLASS', 'EMERGENCY_READ', 'CONFIG_CHANGE', 'REPORT', 'REMINDER', 'MEMBERSHIP_CHANGE', 'PURGE_SOON']::TEXT[];
UPDATE "wellbeing_configs"
SET "alertEvents" = array_append("alertEvents", 'PURGE_SOON')
WHERE NOT ('PURGE_SOON' = ANY("alertEvents"));

-- Effacement anticipé à deux clés et annonce d'effacement.
ALTER TABLE "wellbeing_cases" ADD COLUMN "purgeRequestedById" TEXT,
ADD COLUMN "purgeRequestedByName" TEXT,
ADD COLUMN "purgeRequestedAt" TIMESTAMP(3),
ADD COLUMN "purgeWarnedAt" TIMESTAMP(3);

-- Plan d'action d'un dossier.
CREATE TABLE "wellbeing_case_tasks" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "assigneeId" TEXT,
    "dueAt" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),
    "doneById" TEXT,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wellbeing_case_tasks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "wellbeing_case_tasks_caseId_createdAt_idx" ON "wellbeing_case_tasks"("caseId", "createdAt");

ALTER TABLE "wellbeing_case_tasks" ADD CONSTRAINT "wellbeing_case_tasks_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "wellbeing_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
