-- AlterTable
ALTER TABLE "wellbeing_configs" ALTER COLUMN "alertEvents" SET DEFAULT ARRAY['BREAK_GLASS', 'EMERGENCY_READ', 'CONFIG_CHANGE', 'REPORT', 'REMINDER', 'MEMBERSHIP_CHANGE']::TEXT[];

-- Un rôle de la cellule donné hors du propriétaire est signalé partout, y compris
-- sur les cellules déjà configurées : l'alerte se retire ensuite si on n'en veut pas.
UPDATE "wellbeing_configs"
SET "alertEvents" = array_append("alertEvents", 'MEMBERSHIP_CHANGE')
WHERE NOT ('MEMBERSHIP_CHANGE' = ANY("alertEvents"));
