-- AlterTable
ALTER TABLE "giveaways" ADD COLUMN "conditions" JSONB, ADD COLUMN "discordEventId" TEXT;

-- AlterTable
ALTER TABLE "giveaway_templates" ADD COLUMN "conditions" JSONB, ADD COLUMN "createDiscordEvent" BOOLEAN NOT NULL DEFAULT false;
