-- AegisAI : harcèlement sur la durée et en groupe (tous auteurs vers un même membre).
ALTER TABLE "aegis_configs" ADD COLUMN IF NOT EXISTS "harassmentLongDays" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "aegis_configs" ADD COLUMN IF NOT EXISTS "harassmentLongThreshold" INTEGER NOT NULL DEFAULT 5;
CREATE INDEX IF NOT EXISTS "aegis_detections_guildId_targetUserId_createdAt_idx" ON "aegis_detections"("guildId", "targetUserId", "createdAt");
