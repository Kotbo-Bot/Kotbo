-- Désactivation différée de la cellule.
ALTER TABLE "wellbeing_configs" ADD COLUMN "dissolutionAt" TIMESTAMP(3),
ADD COLUMN "dissolutionById" TEXT,
ADD COLUMN "dissolutionByName" TEXT,
ADD COLUMN "dissolutionKind" TEXT;

-- Réponse de la cellule à l'auteur d'un signalement.
ALTER TABLE "wellbeing_cases" ADD COLUMN "reporterReply" TEXT,
ADD COLUMN "reporterReplyAt" TIMESTAMP(3);

-- L'alerte de dissolution est cochée par défaut, y compris sur les cellules
-- déjà configurées : elle se retire ensuite si on n'en veut pas.
ALTER TABLE "wellbeing_configs" ALTER COLUMN "alertEvents" SET DEFAULT ARRAY['BREAK_GLASS', 'EMERGENCY_READ', 'CONFIG_CHANGE', 'REPORT', 'REMINDER', 'MEMBERSHIP_CHANGE', 'PURGE_SOON', 'UNUSUAL_ACCESS', 'DISSOLUTION']::TEXT[];
UPDATE "wellbeing_configs"
SET "alertEvents" = array_append("alertEvents", 'DISSOLUTION')
WHERE NOT ('DISSOLUTION' = ANY("alertEvents"));
