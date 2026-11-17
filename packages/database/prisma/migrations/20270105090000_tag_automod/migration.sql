-- Automod des tags : réglages, règles, journal, vagues et signalements partagés.
CREATE TABLE IF NOT EXISTS "tag_automod_configs" (
    "guildId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "testMode" BOOLEAN NOT NULL DEFAULT false,
    "onJoin" BOOLEAN NOT NULL DEFAULT true,
    "onTagChange" BOOLEAN NOT NULL DEFAULT true,
    "exemptRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "exemptUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "alertChannelId" TEXT,
    "allowlistOnly" BOOLEAN NOT NULL DEFAULT false,
    "allowlistAction" TEXT NOT NULL DEFAULT 'ALERT',
    "allowlistDurationMin" INTEGER,
    "sharedListEnabled" BOOLEAN NOT NULL DEFAULT false,
    "sharedListAction" TEXT NOT NULL DEFAULT 'ALERT',
    "sharedListDurationMin" INTEGER,
    "waveEnabled" BOOLEAN NOT NULL DEFAULT false,
    "waveMode" TEXT NOT NULL DEFAULT 'ADAPTIVE',
    "wavePreset" TEXT NOT NULL DEFAULT 'NORMAL',
    "waveThreshold" INTEGER NOT NULL DEFAULT 5,
    "waveWindowSec" INTEGER NOT NULL DEFAULT 120,
    "waveAction" TEXT NOT NULL DEFAULT 'JAIL',
    "waveDurationMin" INTEGER,
    "waveBlockHours" INTEGER NOT NULL DEFAULT 24,
    "waveReportFleet" BOOLEAN NOT NULL DEFAULT true,
    "newAccountEnabled" BOOLEAN NOT NULL DEFAULT false,
    "newAccountDays" INTEGER NOT NULL DEFAULT 7,
    "newAccountScope" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "newAccountAction" TEXT NOT NULL DEFAULT 'ALERT',
    "newAccountDurationMin" INTEGER,
    "massAdoptEnabled" BOOLEAN NOT NULL DEFAULT false,
    "massAdoptThreshold" INTEGER NOT NULL DEFAULT 5,
    "massAdoptWindowMin" INTEGER NOT NULL DEFAULT 60,
    "massAdoptAction" TEXT NOT NULL DEFAULT 'ALERT',
    "impersonationEnabled" BOOLEAN NOT NULL DEFAULT false,
    "impersonationAction" TEXT NOT NULL DEFAULT 'ALERT',
    "impersonationDurationMin" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tag_automod_configs_pkey" PRIMARY KEY ("guildId")
);

CREATE TABLE IF NOT EXISTS "tag_automod_rules" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "effect" TEXT NOT NULL DEFAULT 'BLOCK',
    "targetType" TEXT NOT NULL,
    "targetGuildId" TEXT,
    "targetName" TEXT,
    "targetIcon" TEXT,
    "pattern" TEXT,
    "matchMode" TEXT NOT NULL DEFAULT 'EXACT',
    "action" TEXT NOT NULL DEFAULT 'ALERT',
    "durationMin" INTEGER,
    "roleId" TEXT,
    "message" TEXT,
    "escalateAfterMin" INTEGER,
    "escalateAction" TEXT,
    "escalateDurationMin" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tag_automod_rules_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "tag_automod_rules_guildId_idx" ON "tag_automod_rules"("guildId");
CREATE INDEX IF NOT EXISTS "tag_automod_rules_targetGuildId_idx" ON "tag_automod_rules"("targetGuildId");

CREATE TABLE IF NOT EXISTS "tag_automod_events" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userTag" TEXT,
    "tagGuildId" TEXT,
    "tag" TEXT,
    "trigger" TEXT NOT NULL,
    "ruleId" TEXT,
    "waveId" TEXT,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "detail" TEXT,
    "dueAt" TIMESTAMP(3),
    "escalateAction" TEXT,
    "escalateDurationMin" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tag_automod_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "tag_automod_events_guildId_createdAt_idx" ON "tag_automod_events"("guildId", "createdAt");
CREATE INDEX IF NOT EXISTS "tag_automod_events_guildId_tagGuildId_idx" ON "tag_automod_events"("guildId", "tagGuildId");
CREATE INDEX IF NOT EXISTS "tag_automod_events_status_dueAt_idx" ON "tag_automod_events"("status", "dueAt");

CREATE TABLE IF NOT EXISTS "tag_waves" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "tagGuildId" TEXT,
    "tag" TEXT,
    "userIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "kind" TEXT NOT NULL DEFAULT 'ARRIVALS',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "alertChannelId" TEXT,
    "alertMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tag_waves_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "tag_waves_guildId_createdAt_idx" ON "tag_waves"("guildId", "createdAt");
CREATE INDEX IF NOT EXISTS "tag_waves_tagGuildId_idx" ON "tag_waves"("tagGuildId");

CREATE TABLE IF NOT EXISTS "tag_risk_reports" (
    "id" TEXT NOT NULL,
    "tagGuildId" TEXT NOT NULL,
    "reporterGuildId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tag_risk_reports_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "tag_risk_reports_tagGuildId_reporterGuildId_kind_key" ON "tag_risk_reports"("tagGuildId", "reporterGuildId", "kind");
CREATE INDEX IF NOT EXISTS "tag_risk_reports_tagGuildId_idx" ON "tag_risk_reports"("tagGuildId");
