-- Réglages de la cellule de suivi : catégories, protocole de crise, plans
-- d'action types et étiquettes ; étiquettes posées sur les dossiers et les fiches.
ALTER TABLE "wellbeing_configs" ADD COLUMN "caseCategories" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "wellbeing_configs" ADD COLUMN "crisisTasks" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "wellbeing_configs" ADD COLUMN "taskPlans" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "wellbeing_configs" ADD COLUMN "caseTags" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "wellbeing_cases" ADD COLUMN "tagIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "wellbeing_profiles" ADD COLUMN "tagIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
