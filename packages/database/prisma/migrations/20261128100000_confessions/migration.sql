-- Confessions anonymes (module Salons fun).
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "funConfessionChannelId" TEXT;
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "funConfessionLogChannelId" TEXT;

CREATE TABLE IF NOT EXISTS "confessions" (
  "id" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "number" INTEGER NOT NULL,
  "authorId" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "messageId" TEXT,
  "revealedAt" TIMESTAMP(3),
  "revealedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "confessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "confessions_guildId_number_key" ON "confessions"("guildId", "number");
CREATE INDEX IF NOT EXISTS "confessions_guildId_authorId_createdAt_idx" ON "confessions"("guildId", "authorId", "createdAt");

ALTER TABLE "confessions" DROP CONSTRAINT IF EXISTS "confessions_guildId_fkey";
ALTER TABLE "confessions"
  ADD CONSTRAINT "confessions_guildId_fkey"
  FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
