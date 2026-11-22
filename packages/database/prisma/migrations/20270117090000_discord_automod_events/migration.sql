-- AlterTable
ALTER TABLE "automod_configs" ADD COLUMN     "discordRulesWarn" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "discord_automod_events" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "ruleName" TEXT NOT NULL,
    "triggerType" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channelId" TEXT,
    "keyword" TEXT,
    "content" TEXT,
    "managed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discord_automod_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "discord_automod_events_guildId_createdAt_idx" ON "discord_automod_events"("guildId", "createdAt");

-- CreateIndex
CREATE INDEX "discord_automod_events_guildId_userId_createdAt_idx" ON "discord_automod_events"("guildId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "discord_automod_events_guildId_ruleId_createdAt_idx" ON "discord_automod_events"("guildId", "ruleId", "createdAt");
