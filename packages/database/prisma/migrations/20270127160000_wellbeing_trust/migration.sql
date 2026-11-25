-- Historique chaîné : empreinte de chaque entrée, liée à la précédente.
ALTER TABLE "wellbeing_case_events" ADD COLUMN "hash" TEXT;

-- Code de suivi d'un signalement : seule son empreinte est gardée.
ALTER TABLE "wellbeing_cases" ADD COLUMN "trackingCodeHash" TEXT;
CREATE UNIQUE INDEX "wellbeing_cases_trackingCodeHash_key" ON "wellbeing_cases"("trackingCodeHash");

-- L'alerte de consultation inhabituelle est cochée par défaut, y compris sur
-- les cellules déjà configurées : elle se retire ensuite si on n'en veut pas.
ALTER TABLE "wellbeing_configs" ALTER COLUMN "alertEvents" SET DEFAULT ARRAY['BREAK_GLASS', 'EMERGENCY_READ', 'CONFIG_CHANGE', 'REPORT', 'REMINDER', 'MEMBERSHIP_CHANGE', 'PURGE_SOON', 'UNUSUAL_ACCESS']::TEXT[];
UPDATE "wellbeing_configs"
SET "alertEvents" = array_append("alertEvents", 'UNUSUAL_ACCESS')
WHERE NOT ('UNUSUAL_ACCESS' = ANY("alertEvents"));
