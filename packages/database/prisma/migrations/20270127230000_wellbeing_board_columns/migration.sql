-- Colonnes ajoutées par la cellule à la vue en colonnes, et étape d'un dossier.
ALTER TABLE "wellbeing_configs" ADD COLUMN "boardColumns" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "wellbeing_cases" ADD COLUMN "stage" TEXT;
