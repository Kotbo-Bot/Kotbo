-- Réglages du module Réputation, une ligne par serveur.
CREATE TABLE IF NOT EXISTS "reputation_configs" (
    "guildId" TEXT NOT NULL,
    "dailyLimit" INTEGER NOT NULL DEFAULT 3,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reputation_configs_pkey" PRIMARY KEY ("guildId")
);

DO $$ BEGIN
  ALTER TABLE "reputation_configs" ADD CONSTRAINT "reputation_configs_guildId_fkey"
    FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Message remercié, quand le vote en vient.
ALTER TABLE "reputation_votes" ADD COLUMN IF NOT EXISTS "channelId" TEXT;
ALTER TABLE "reputation_votes" ADD COLUMN IF NOT EXISTS "messageId" TEXT;

-- Historique du dashboard, du plus récent au plus ancien.
CREATE INDEX IF NOT EXISTS "reputation_votes_guildId_createdAt_idx" ON "reputation_votes"("guildId", "createdAt");
