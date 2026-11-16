-- Starlight : âge maximum, seuils par salon, membres exclus.
ALTER TABLE "starboard_configs" ADD COLUMN IF NOT EXISTS "maxMessageAgeDays" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "starboard_configs" ADD COLUMN IF NOT EXISTS "channelThresholds" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "starboard_configs" ADD COLUMN IF NOT EXISTS "blockedUserIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Message retiré de la une par le staff.
ALTER TABLE "starboard_entries" ADD COLUMN IF NOT EXISTS "blockedAt" TIMESTAMP(3);
ALTER TABLE "starboard_entries" ADD COLUMN IF NOT EXISTS "blockedById" TEXT;
