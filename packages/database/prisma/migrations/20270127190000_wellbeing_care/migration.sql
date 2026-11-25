-- Protocole de crise, prise de nouvelles, signal aux modérateurs, mots de détresse, météo du staff.
ALTER TABLE "wellbeing_configs" ADD COLUMN "crisisProtocol" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "followUpDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN "sanctionSignal" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "distressWatch" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "pulseEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "pulseRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "pulseSentAt" TIMESTAMP(3);

-- L'alerte des mots de détresse est cochée par défaut, y compris sur les
-- cellules déjà configurées : elle ne part que si le repérage est activé.
ALTER TABLE "wellbeing_configs" ALTER COLUMN "alertEvents" SET DEFAULT ARRAY['BREAK_GLASS', 'EMERGENCY_READ', 'CONFIG_CHANGE', 'REPORT', 'REMINDER', 'MEMBERSHIP_CHANGE', 'PURGE_SOON', 'UNUSUAL_ACCESS', 'DISSOLUTION', 'DISTRESS']::TEXT[];
UPDATE "wellbeing_configs"
SET "alertEvents" = array_append("alertEvents", 'DISTRESS')
WHERE NOT ('DISTRESS' = ANY("alertEvents"));

-- Ticket transféré et rappel de prise de nouvelles.
ALTER TABLE "wellbeing_cases" ADD COLUMN "ticketId" TEXT,
ADD COLUMN "followUpAt" TIMESTAMP(3),
ADD COLUMN "followUpSentAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "wellbeing_cases_ticketId_key" ON "wellbeing_cases"("ticketId");
CREATE INDEX "wellbeing_cases_status_followUpAt_idx" ON "wellbeing_cases"("status", "followUpAt");

-- Fil anonyme avec le signaleur.
CREATE TABLE "wellbeing_reporter_messages" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "fromReporter" BOOLEAN NOT NULL,
    "content" TEXT NOT NULL,
    "authorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wellbeing_reporter_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "wellbeing_reporter_messages_caseId_createdAt_idx" ON "wellbeing_reporter_messages"("caseId", "createdAt");
ALTER TABLE "wellbeing_reporter_messages" ADD CONSTRAINT "wellbeing_reporter_messages_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "wellbeing_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- L'ancienne réponse unique devient le premier message de la cellule. Le
-- chiffré est lié au serveur dans les deux cas : il se recopie tel quel.
INSERT INTO "wellbeing_reporter_messages" ("id", "caseId", "fromReporter", "content", "createdAt")
SELECT 'migrated-' || "id", "id", false, "reporterReply", COALESCE("reporterReplyAt", "updatedAt")
FROM "wellbeing_cases"
WHERE "reporterReply" IS NOT NULL;
ALTER TABLE "wellbeing_cases" DROP COLUMN "reporterReply",
DROP COLUMN "reporterReplyAt";

-- Signaux de détresse.
CREATE TABLE "wellbeing_distress_signals" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handledAt" TIMESTAMP(3),
    "handledById" TEXT,
    "handledByName" TEXT,
    "outcome" TEXT,
    "caseId" TEXT,

    CONSTRAINT "wellbeing_distress_signals_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "wellbeing_distress_signals_guildId_handledAt_idx" ON "wellbeing_distress_signals"("guildId", "handledAt");
CREATE INDEX "wellbeing_distress_signals_createdAt_idx" ON "wellbeing_distress_signals"("createdAt");
ALTER TABLE "wellbeing_distress_signals" ADD CONSTRAINT "wellbeing_distress_signals_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Météo du staff.
CREATE TABLE "wellbeing_pulse_weeks" (
    "guildId" TEXT NOT NULL,
    "week" TEXT NOT NULL,
    "score1" INTEGER NOT NULL DEFAULT 0,
    "score2" INTEGER NOT NULL DEFAULT 0,
    "score3" INTEGER NOT NULL DEFAULT 0,
    "score4" INTEGER NOT NULL DEFAULT 0,
    "score5" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "wellbeing_pulse_weeks_pkey" PRIMARY KEY ("guildId", "week")
);
ALTER TABLE "wellbeing_pulse_weeks" ADD CONSTRAINT "wellbeing_pulse_weeks_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "wellbeing_pulse_voters" (
    "guildId" TEXT NOT NULL,
    "week" TEXT NOT NULL,
    "voterHash" TEXT NOT NULL,

    CONSTRAINT "wellbeing_pulse_voters_pkey" PRIMARY KEY ("guildId", "week", "voterHash")
);
