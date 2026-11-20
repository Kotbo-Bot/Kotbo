-- Garde-fous des votes, gains repris au retrait, ajustements du staff.
DO $$ BEGIN
  CREATE TYPE "ReputationVoteKind" AS ENUM ('VOTE', 'ADJUSTMENT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "reputation_votes" ADD COLUMN IF NOT EXISTS "kind" "ReputationVoteKind" NOT NULL DEFAULT 'VOTE';
ALTER TABLE "reputation_votes" ADD COLUMN IF NOT EXISTS "xpGranted" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "reputation_votes" ADD COLUMN IF NOT EXISTS "coinsGranted" INTEGER NOT NULL DEFAULT 0;
-- Un ajustement n'a pas de jour : il échappe à la contrainte « un vote par jour ».
ALTER TABLE "reputation_votes" ALTER COLUMN "day" DROP NOT NULL;

ALTER TABLE "reputation_configs" ADD COLUMN IF NOT EXISTS "minAccountAgeDays" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "reputation_configs" ADD COLUMN IF NOT EXISTS "minMemberDays" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "reputation_configs" ADD COLUMN IF NOT EXISTS "sameMemberCooldownDays" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "reputation_configs" ADD COLUMN IF NOT EXISTS "excludedRoleIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "reputation_configs" ADD COLUMN IF NOT EXISTS "excludedChannelIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
