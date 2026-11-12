-- Drops : attente d'activité dans le salon, réglée par type.

ALTER TABLE "drop_configs" ADD COLUMN IF NOT EXISTS "activityMinMessages" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "drop_configs" ADD COLUMN IF NOT EXISTS "activityWindowMinutes" INTEGER NOT NULL DEFAULT 15;
