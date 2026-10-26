-- Convocations de membres par la modération.
CREATE TABLE IF NOT EXISTS "convocations" (
  "id" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "staffId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "deadline" TIMESTAMP(3) NOT NULL,
  "expiryAction" TEXT NOT NULL DEFAULT 'ALERT',
  "waitingChannelId" TEXT,
  "channelId" TEXT NOT NULL,
  "messageId" TEXT,
  "threadId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "acknowledgedAt" TIMESTAMP(3),
  "answeredAt" TIMESTAMP(3),
  "closedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "convocations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "convocations_threadId_key" ON "convocations"("threadId");
CREATE INDEX IF NOT EXISTS "convocations_status_deadline_idx" ON "convocations"("status", "deadline");
CREATE INDEX IF NOT EXISTS "convocations_guildId_userId_idx" ON "convocations"("guildId", "userId");
CREATE INDEX IF NOT EXISTS "convocations_messageId_idx" ON "convocations"("messageId");

ALTER TABLE "convocations"
  DROP CONSTRAINT IF EXISTS "convocations_guildId_fkey";
ALTER TABLE "convocations"
  ADD CONSTRAINT "convocations_guildId_fkey"
  FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
