-- Site communautaire : votes pour le serveur sur les sites de classement
-- (top.gg, sites de serveurs de jeu…), séries de votes et rappels.
-- Rejouable : chaque création est gardée.

ALTER TABLE "site_member_settings" ADD COLUMN IF NOT EXISTS "voteStreak" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "site_member_settings" ADD COLUMN IF NOT EXISTS "lastVoteDayKey" TEXT;
ALTER TABLE "site_member_settings" ADD COLUMN IF NOT EXISTS "lastVoteReminderAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "site_vote_sites" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "voteUrl" TEXT NOT NULL,
    "verificationKey" TEXT,
    "webhookSecret" TEXT,
    "cooldownHours" INTEGER NOT NULL DEFAULT 24,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "site_vote_sites_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "site_vote_sites_guildId_idx" ON "site_vote_sites"("guildId");

CREATE TABLE IF NOT EXISTS "site_votes" (
    "id" TEXT NOT NULL,
    "voteSiteId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "window" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "coins" INTEGER NOT NULL DEFAULT 0,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "site_votes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "site_votes_window_key" ON "site_votes"("voteSiteId", "userId", "window");
CREATE INDEX IF NOT EXISTS "site_votes_guildId_createdAt_idx" ON "site_votes"("guildId", "createdAt");
CREATE INDEX IF NOT EXISTS "site_votes_guildId_userId_createdAt_idx" ON "site_votes"("guildId", "userId", "createdAt");

DO $$ BEGIN
    ALTER TABLE "site_vote_sites" ADD CONSTRAINT "site_vote_sites_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "community_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "site_votes" ADD CONSTRAINT "site_votes_voteSiteId_fkey" FOREIGN KEY ("voteSiteId") REFERENCES "site_vote_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
