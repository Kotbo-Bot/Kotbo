-- Création de la table discord_external_guilds pour la persistance des métadonnées des serveurs Discord
-- (serveurs visités par le bot ou tiers vus via tags/emojis/stickers/preview/widget).

CREATE TABLE IF NOT EXISTS "discord_external_guilds" (
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "description" TEXT,
    "memberCount" INTEGER,
    "onlineCount" INTEGER,
    "tag" TEXT,
    "badge" TEXT,
    "source" TEXT NOT NULL DEFAULT 'tag',
    "botPresent" BOOLEAN NOT NULL DEFAULT false,
    "botLeftAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discord_external_guilds_pkey" PRIMARY KEY ("guildId")
);

CREATE INDEX IF NOT EXISTS "discord_external_guilds_botPresent_botLeftAt_idx" ON "discord_external_guilds"("botPresent", "botLeftAt");

-- Colonnes de tag serveur sur member_profiles (rattrapage de c8ff31773a8019ab375641f1951a2c19b1f3a67a)
ALTER TABLE "member_profiles" ADD COLUMN IF NOT EXISTS "primaryGuildId" TEXT;
ALTER TABLE "member_profiles" ADD COLUMN IF NOT EXISTS "primaryGuildTag" TEXT;
ALTER TABLE "member_profiles" ADD COLUMN IF NOT EXISTS "primaryGuildBadge" TEXT;
ALTER TABLE "member_profiles" ADD COLUMN IF NOT EXISTS "primaryGuildUpdatedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "member_profiles_guildId_primaryGuildId_idx" ON "member_profiles"("guildId", "primaryGuildId");

