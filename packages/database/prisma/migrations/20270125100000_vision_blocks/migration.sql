-- Historique des images bloquées par Kotbo Vision.
CREATE TABLE IF NOT EXISTS "vision_blocks" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "listId" TEXT,
    "matchId" TEXT,
    "kind" TEXT NOT NULL,
    "similarity" DOUBLE PRECISION,
    "sanction" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vision_blocks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "vision_blocks_guildId_createdAt_idx" ON "vision_blocks"("guildId", "createdAt");
CREATE INDEX IF NOT EXISTS "vision_blocks_guildId_authorId_idx" ON "vision_blocks"("guildId", "authorId");

DO $$ BEGIN
  ALTER TABLE "vision_blocks" ADD CONSTRAINT "vision_blocks_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
