-- Remerciement par réaction et gains du membre remercié.
ALTER TABLE "reputation_configs" ADD COLUMN IF NOT EXISTS "reactionEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "reputation_configs" ADD COLUMN IF NOT EXISTS "reactionEmoji" TEXT;
ALTER TABLE "reputation_configs" ADD COLUMN IF NOT EXISTS "xpPerRep" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "reputation_configs" ADD COLUMN IF NOT EXISTS "coinsPerRep" INTEGER NOT NULL DEFAULT 0;
