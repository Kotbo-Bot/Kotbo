-- Fils automatiques : plusieurs configurations par salon (déclenchement,
-- conditions, nommage, rejet des messages non conformes). Rejouable.

CREATE TABLE IF NOT EXISTS "auto_thread_configs" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Configuration',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "trigger" TEXT NOT NULL DEFAULT 'all',
    "conditions" JSONB,
    "namingMode" TEXT NOT NULL DEFAULT 'author_first_line',
    "namingRules" JSONB,
    "archiveMinutes" INTEGER NOT NULL DEFAULT 1440,
    "renamePermission" TEXT NOT NULL DEFAULT 'moderators',
    "allowBots" BOOLEAN NOT NULL DEFAULT false,
    "threadCount" INTEGER NOT NULL DEFAULT 0,
    "rejectAction" TEXT NOT NULL DEFAULT 'keep',
    "rejectDelaySeconds" INTEGER NOT NULL DEFAULT 60,
    "rejectMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "auto_thread_configs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "auto_thread_configs_guildId_channelId_position_idx"
    ON "auto_thread_configs"("guildId", "channelId", "position");

DO $$ BEGIN
    ALTER TABLE "auto_thread_configs" ADD CONSTRAINT "auto_thread_configs_guildId_fkey"
        FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "auto_thread_created" (
    "threadId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "auto_thread_created_pkey" PRIMARY KEY ("threadId")
);
CREATE INDEX IF NOT EXISTS "auto_thread_created_guildId_idx" ON "auto_thread_created"("guildId");
CREATE INDEX IF NOT EXISTS "auto_thread_created_configId_idx" ON "auto_thread_created"("configId");

DO $$ BEGIN
    ALTER TABLE "auto_thread_created" ADD CONSTRAINT "auto_thread_created_configId_fkey"
        FOREIGN KEY ("configId") REFERENCES "auto_thread_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Reprise de l'existant : chaque salon de `autoThreadChannels` devient une
-- configuration « tous les messages », nommée comme avant (« Fil de X - ... »),
-- qui hérite du réglage serveur sur les bots. Un salon déjà repris est sauté.
INSERT INTO "auto_thread_configs" ("id", "guildId", "channelId", "name", "allowBots", "updatedAt")
SELECT
    'atc' || substr(md5(g."id" || ':' || ch.channel_id), 1, 22),
    g."id",
    ch.channel_id,
    'Configuration',
    g."autoThreadBotsEnabled",
    CURRENT_TIMESTAMP
FROM "guilds" g
CROSS JOIN LATERAL unnest(g."autoThreadChannels") AS ch(channel_id)
WHERE NOT EXISTS (
    SELECT 1 FROM "auto_thread_configs" c
    WHERE c."guildId" = g."id" AND c."channelId" = ch.channel_id
);
