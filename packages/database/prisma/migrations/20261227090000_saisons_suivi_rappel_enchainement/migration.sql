-- Récompenses réellement remises, enchaînement automatique et rappel de fin.
ALTER TABLE "leveling_seasons" ADD COLUMN IF NOT EXISTS "autoRenew" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "leveling_seasons" ADD COLUMN IF NOT EXISTS "remindBeforeEnd" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "leveling_seasons" ADD COLUMN IF NOT EXISTS "reminderSentAt" TIMESTAMP(3);
ALTER TABLE "leveling_seasons" ADD COLUMN IF NOT EXISTS "grantedRewards" JSONB;

-- ARCHIVED n'était atteint par aucun chemin : les saisons qui l'auraient
-- redeviennent terminées, puis la valeur quitte le type.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'SeasonStatus' AND e.enumlabel = 'ARCHIVED'
  ) THEN
    UPDATE "leveling_seasons" SET "status" = 'ENDED' WHERE "status" = 'ARCHIVED';
    ALTER TYPE "SeasonStatus" RENAME TO "SeasonStatus_old";
    CREATE TYPE "SeasonStatus" AS ENUM ('UPCOMING', 'ACTIVE', 'ENDED');
    ALTER TABLE "leveling_seasons" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "leveling_seasons" ALTER COLUMN "status" TYPE "SeasonStatus" USING "status"::text::"SeasonStatus";
    ALTER TABLE "leveling_seasons" ALTER COLUMN "status" SET DEFAULT 'UPCOMING';
    DROP TYPE "SeasonStatus_old";
  END IF;
END $$;
