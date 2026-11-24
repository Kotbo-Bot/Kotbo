-- AlterTable
ALTER TABLE "automod_configs" ADD COLUMN "hateSymbolsEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "hateSymbolsAction" TEXT NOT NULL DEFAULT 'DELETE_AND_WARN',
ADD COLUMN "hateSymbolsAllowed" TEXT[] DEFAULT ARRAY[]::TEXT[];
