-- Suivi des boosts : boost en cours sur le profil, historique et snapshot quotidien.
ALTER TABLE "member_profiles" ADD COLUMN IF NOT EXISTS "boostingSince" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "member_profiles_guildId_boostingSince_idx" ON "member_profiles"("guildId", "boostingSince");

CREATE TABLE IF NOT EXISTS "boost_events" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "boostingSince" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "boost_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "boost_events_guildId_createdAt_idx" ON "boost_events"("guildId", "createdAt");
CREATE INDEX IF NOT EXISTS "boost_events_guildId_userId_createdAt_idx" ON "boost_events"("guildId", "userId", "createdAt");

CREATE TABLE IF NOT EXISTS "guild_boost_snapshots" (
    "guildId" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "boostCount" INTEGER NOT NULL,
    "boosterCount" INTEGER NOT NULL,
    "tier" INTEGER NOT NULL,
    CONSTRAINT "guild_boost_snapshots_pkey" PRIMARY KEY ("guildId", "dateKey")
);
