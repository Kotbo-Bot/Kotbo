-- Panneaux de discussion : un message à boutons qui ouvre des fils publics,
-- privés ou des posts de forum, et le suivi des fils ouverts. Rejouable.

CREATE TABLE IF NOT EXISTS "thread_panels" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT,
    "name" TEXT NOT NULL DEFAULT 'Panneau de discussion',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "color" TEXT NOT NULL DEFAULT '#5865f2',
    "imageUrl" TEXT,
    "logChannelId" TEXT,
    "buttons" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "thread_panels_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "thread_panels_guildId_idx" ON "thread_panels"("guildId");

DO $$ BEGIN
    ALTER TABLE "thread_panels" ADD CONSTRAINT "thread_panels_guildId_fkey"
        FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "panel_threads" (
    "threadId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "panelId" TEXT NOT NULL,
    "buttonId" TEXT NOT NULL,
    "parentId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "trustedIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bannedIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "announceMessageId" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "panel_threads_pkey" PRIMARY KEY ("threadId")
);
CREATE INDEX IF NOT EXISTS "panel_threads_panelId_buttonId_ownerId_idx" ON "panel_threads"("panelId", "buttonId", "ownerId");
CREATE INDEX IF NOT EXISTS "panel_threads_guildId_idx" ON "panel_threads"("guildId");

DO $$ BEGIN
    ALTER TABLE "panel_threads" ADD CONSTRAINT "panel_threads_panelId_fkey"
        FOREIGN KEY ("panelId") REFERENCES "thread_panels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
