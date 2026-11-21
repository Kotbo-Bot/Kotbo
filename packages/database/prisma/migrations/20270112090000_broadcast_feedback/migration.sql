-- Broadcast : demande d'avis (bouton sur l'annonce et retours libres).
ALTER TABLE "broadcast_logs"
  ADD COLUMN IF NOT EXISTS "feedbackLabel" TEXT;

CREATE TABLE IF NOT EXISTS "broadcast_feedbacks" (
  "id" TEXT NOT NULL,
  "broadcastId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "broadcast_feedbacks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "broadcast_feedbacks_broadcastId_createdAt_idx"
  ON "broadcast_feedbacks"("broadcastId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "broadcast_feedbacks"
    ADD CONSTRAINT "broadcast_feedbacks_broadcastId_fkey"
    FOREIGN KEY ("broadcastId") REFERENCES "broadcast_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
