-- Suggestions : titre, fil de discussion et seuil de votes.
ALTER TABLE "suggestions" ADD COLUMN IF NOT EXISTS "title" TEXT;
ALTER TABLE "suggestions" ADD COLUMN IF NOT EXISTS "threadId" TEXT;
ALTER TABLE "suggestions" ADD COLUMN IF NOT EXISTS "thresholdReachedAt" TIMESTAMP(3);

-- Réglages : garde-fous, auteur prévenu, fil, seuil de votes.
ALTER TABLE "suggestion_configs" ADD COLUMN IF NOT EXISTS "cooldownMinutes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "suggestion_configs" ADD COLUMN IF NOT EXISTS "minAccountAgeDays" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "suggestion_configs" ADD COLUMN IF NOT EXISTS "minMemberDays" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "suggestion_configs" ADD COLUMN IF NOT EXISTS "notifyAuthor" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "suggestion_configs" ADD COLUMN IF NOT EXISTS "createThread" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "suggestion_configs" ADD COLUMN IF NOT EXISTS "voteThreshold" INTEGER;
ALTER TABLE "suggestion_configs" ADD COLUMN IF NOT EXISTS "pinAtThreshold" BOOLEAN NOT NULL DEFAULT false;
