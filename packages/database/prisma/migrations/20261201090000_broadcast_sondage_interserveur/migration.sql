-- Broadcast : sondage interserveur (options sur l'annonce, un vote par personne).
ALTER TABLE "broadcast_logs"
  ADD COLUMN IF NOT EXISTS "pollOptions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "pollClosesAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "broadcast_poll_votes" (
  "broadcastId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "optionIndex" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "broadcast_poll_votes_pkey" PRIMARY KEY ("broadcastId", "userId")
);

CREATE INDEX IF NOT EXISTS "broadcast_poll_votes_broadcastId_optionIndex_idx"
  ON "broadcast_poll_votes"("broadcastId", "optionIndex");

DO $$ BEGIN
  ALTER TABLE "broadcast_poll_votes"
    ADD CONSTRAINT "broadcast_poll_votes_broadcastId_fkey"
    FOREIGN KEY ("broadcastId") REFERENCES "broadcast_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
