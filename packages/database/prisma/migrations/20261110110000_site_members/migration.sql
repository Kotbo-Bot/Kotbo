-- Site communautaire : réglages des membres (profil public, notifications,
-- séries) et journal des récompenses versées pour l'activité sur le site.
-- Rejouable : chaque création est gardée.

ALTER TABLE "community_sites" ADD COLUMN IF NOT EXISTS "rewards" JSONB NOT NULL DEFAULT '{}';

DO $$ BEGIN
    CREATE TYPE "SiteRewardKind" AS ENUM ('DAILY', 'PARTICIPATION', 'READ', 'VOTE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "site_member_settings" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "profileHidden" BOOLEAN NOT NULL DEFAULT false,
    "notifications" JSONB NOT NULL DEFAULT '{}',
    "dailyStreak" INTEGER NOT NULL DEFAULT 0,
    "lastDailyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "site_member_settings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "site_member_settings_key" ON "site_member_settings"("guildId", "userId");

CREATE TABLE IF NOT EXISTS "site_reward_logs" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "SiteRewardKind" NOT NULL,
    "refKey" TEXT NOT NULL,
    "coins" INTEGER NOT NULL DEFAULT 0,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "site_reward_logs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "site_reward_logs_key" ON "site_reward_logs"("guildId", "userId", "refKey");
CREATE INDEX IF NOT EXISTS "site_reward_logs_guildId_userId_createdAt_idx" ON "site_reward_logs"("guildId", "userId", "createdAt");

CREATE TABLE IF NOT EXISTS "site_ticket_links" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lastNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "site_ticket_links_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "site_ticket_links_ticketId_key" ON "site_ticket_links"("ticketId");
CREATE INDEX IF NOT EXISTS "site_ticket_links_guildId_idx" ON "site_ticket_links"("guildId");
