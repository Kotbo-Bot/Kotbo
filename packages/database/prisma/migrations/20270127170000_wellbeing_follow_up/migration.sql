-- Suppléant des référents absents et résumé hebdomadaire de la cellule.
ALTER TABLE "wellbeing_configs" ADD COLUMN "backupUserId" TEXT,
ADD COLUMN "digestSentAt" TIMESTAMP(3);

-- Motif de clôture d'un dossier.
ALTER TABLE "wellbeing_cases" ADD COLUMN "closedReason" TEXT;

-- Correction d'une note par son auteur, version d'origine conservée.
ALTER TABLE "wellbeing_case_notes" ADD COLUMN "originalContent" TEXT,
ADD COLUMN "editedAt" TIMESTAMP(3);
