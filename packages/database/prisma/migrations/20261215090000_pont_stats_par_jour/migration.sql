-- Ponts : messages envoyés, reçus et perdus, par jour, pont et salon.
CREATE TABLE IF NOT EXISTS "channel_link_group_daily_stats" (
    "groupId" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "received" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "channel_link_group_daily_stats_pkey" PRIMARY KEY ("groupId", "dateKey", "guildId", "channelId")
);
DO $$ BEGIN
    ALTER TABLE "channel_link_group_daily_stats" ADD CONSTRAINT "channel_link_group_daily_stats_groupId_fkey"
        FOREIGN KEY ("groupId") REFERENCES "channel_link_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
