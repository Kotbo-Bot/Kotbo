-- Rattrapage de 20261125100000_featured_guilds : la table existait deja en
-- production sans ces colonnes, le CREATE TABLE IF NOT EXISTS ne les a donc pas ajoutees.
ALTER TABLE "featured_guilds" ADD COLUMN IF NOT EXISTS "description" TEXT NOT NULL DEFAULT '';
ALTER TABLE "featured_guilds" ADD COLUMN IF NOT EXISTS "iconUrl" TEXT;
ALTER TABLE "featured_guilds" ADD COLUMN IF NOT EXISTS "memberCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "featured_guilds" ADD COLUMN IF NOT EXISTS "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "featured_guilds" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS "featured_guilds_memberCount_idx" ON "featured_guilds"("memberCount");
CREATE INDEX IF NOT EXISTS "featured_guilds_lastSeenAt_idx" ON "featured_guilds"("lastSeenAt");
