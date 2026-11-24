-- AlterTable
ALTER TABLE "tag_automod_configs" ADD COLUMN "presetCategories" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "presetAction" TEXT NOT NULL DEFAULT 'ALERT',
ADD COLUMN "presetDurationMin" INTEGER,
ADD COLUMN "presetExcluded" TEXT[] DEFAULT ARRAY[]::TEXT[];
