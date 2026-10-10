-- Kotbo × AegisAI : configuration, détections, agrégats et humeur des tickets.
CREATE TABLE IF NOT EXISTS "aegis_configs" (
    "guildId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "trainingConsent" BOOLEAN,
    "trainingConsentById" TEXT,
    "trainingConsentAt" TIMESTAMP(3),
    "reviewThreshold" INTEGER NOT NULL DEFAULT 80,
    "autoThreshold" INTEGER NOT NULL DEFAULT 95,
    "autoAction" TEXT NOT NULL DEFAULT 'DELETE_AND_WARN',
    "warnWeight" INTEGER NOT NULL DEFAULT 2,
    "timeoutMinutes" INTEGER NOT NULL DEFAULT 10,
    "notifyMember" BOOLEAN NOT NULL DEFAULT true,
    "reviewChannelId" TEXT,
    "exemptChannelIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "exemptRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "analyzeEdits" BOOLEAN NOT NULL DEFAULT true,
    "analyzeNicknames" BOOLEAN NOT NULL DEFAULT false,
    "analyzeTickets" BOOLEAN NOT NULL DEFAULT true,
    "ticketPriorityBoost" BOOLEAN NOT NULL DEFAULT false,
    "conflictEnabled" BOOLEAN NOT NULL DEFAULT false,
    "conflictWindowSec" INTEGER NOT NULL DEFAULT 120,
    "conflictMessageThreshold" INTEGER NOT NULL DEFAULT 4,
    "conflictSlowmodeSec" INTEGER NOT NULL DEFAULT 10,
    "conflictDurationMin" INTEGER NOT NULL DEFAULT 10,
    "harassmentEnabled" BOOLEAN NOT NULL DEFAULT false,
    "harassmentWindowMin" INTEGER NOT NULL DEFAULT 30,
    "harassmentThreshold" INTEGER NOT NULL DEFAULT 3,
    "harassmentAction" TEXT NOT NULL DEFAULT 'ALERT',
    "distressEnabled" BOOLEAN NOT NULL DEFAULT false,
    "distressThreshold" INTEGER NOT NULL DEFAULT 95,
    "distressChannelId" TEXT,
    "distressCooldownHours" INTEGER NOT NULL DEFAULT 24,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "aegis_configs_pkey" PRIMARY KEY ("guildId")
);
DO $$ BEGIN
    ALTER TABLE "aegis_configs" ADD CONSTRAINT "aegis_configs_guildId_fkey"
        FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "aegis_detections" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT,
    "authorId" TEXT NOT NULL,
    "targetUserId" TEXT,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MESSAGE',
    "toxicity" DOUBLE PRECISION,
    "emotion" TEXT,
    "emotionScore" DOUBLE PRECISION,
    "excerpt" TEXT,
    "action" TEXT NOT NULL DEFAULT 'NONE',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "late" BOOLEAN NOT NULL DEFAULT false,
    "sanctionId" TEXT,
    "previousSlowmode" INTEGER,
    "restoreAt" TIMESTAMP(3),
    "restoredAt" TIMESTAMP(3),
    "alertChannelId" TEXT,
    "alertMessageId" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "aegis_detections_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "aegis_detections_guildId_createdAt_idx" ON "aegis_detections"("guildId", "createdAt");
CREATE INDEX IF NOT EXISTS "aegis_detections_guildId_status_createdAt_idx" ON "aegis_detections"("guildId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "aegis_detections_guildId_authorId_createdAt_idx" ON "aegis_detections"("guildId", "authorId", "createdAt");
CREATE INDEX IF NOT EXISTS "aegis_detections_restoreAt_idx" ON "aegis_detections"("restoreAt");
DO $$ BEGIN
    ALTER TABLE "aegis_detections" ADD CONSTRAINT "aegis_detections_guildId_fkey"
        FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "aegis_hourly_stats" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "hour" INTEGER NOT NULL,
    "channelId" TEXT NOT NULL,
    "analyzed" INTEGER NOT NULL DEFAULT 0,
    "toxic" INTEGER NOT NULL DEFAULT 0,
    "severe" INTEGER NOT NULL DEFAULT 0,
    "toxicityMilli" INTEGER NOT NULL DEFAULT 0,
    "emotionAnalyzed" INTEGER NOT NULL DEFAULT 0,
    "joy" INTEGER NOT NULL DEFAULT 0,
    "sad" INTEGER NOT NULL DEFAULT 0,
    "anger" INTEGER NOT NULL DEFAULT 0,
    "fear" INTEGER NOT NULL DEFAULT 0,
    "surprise" INTEGER NOT NULL DEFAULT 0,
    "neutral" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "aegis_hourly_stats_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "aegis_hourly_stats_guildId_dateKey_hour_channelId_key"
    ON "aegis_hourly_stats"("guildId", "dateKey", "hour", "channelId");
CREATE INDEX IF NOT EXISTS "aegis_hourly_stats_guildId_dateKey_idx" ON "aegis_hourly_stats"("guildId", "dateKey");
DO $$ BEGIN
    ALTER TABLE "aegis_hourly_stats" ADD CONSTRAINT "aegis_hourly_stats_guildId_fkey"
        FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "aegis_member_daily_stats" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "analyzed" INTEGER NOT NULL DEFAULT 0,
    "toxic" INTEGER NOT NULL DEFAULT 0,
    "toxicityMilli" INTEGER NOT NULL DEFAULT 0,
    "emotionAnalyzed" INTEGER NOT NULL DEFAULT 0,
    "joy" INTEGER NOT NULL DEFAULT 0,
    "sad" INTEGER NOT NULL DEFAULT 0,
    "anger" INTEGER NOT NULL DEFAULT 0,
    "fear" INTEGER NOT NULL DEFAULT 0,
    "surprise" INTEGER NOT NULL DEFAULT 0,
    "neutral" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "aegis_member_daily_stats_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "aegis_member_daily_stats_guildId_dateKey_userId_key"
    ON "aegis_member_daily_stats"("guildId", "dateKey", "userId");
CREATE INDEX IF NOT EXISTS "aegis_member_daily_stats_guildId_userId_dateKey_idx"
    ON "aegis_member_daily_stats"("guildId", "userId", "dateKey");
DO $$ BEGIN
    ALTER TABLE "aegis_member_daily_stats" ADD CONSTRAINT "aegis_member_daily_stats_guildId_fkey"
        FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "moodLabel" TEXT;
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "moodScore" DOUBLE PRECISION;
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "peakToxicity" DOUBLE PRECISION;
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "moodUpdatedAt" TIMESTAMP(3);
