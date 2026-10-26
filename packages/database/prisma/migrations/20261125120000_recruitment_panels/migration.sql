-- Fermeture automatique des formulaires de recrutement (plafonds d'attente et d'acceptés).
ALTER TABLE "custom_forms"
  ADD COLUMN IF NOT EXISTS "maxPendingCandidatures" INTEGER,
  ADD COLUMN IF NOT EXISTS "maxAcceptedCandidatures" INTEGER,
  ADD COLUMN IF NOT EXISTS "acceptedCapMode" TEXT NOT NULL DEFAULT 'RESET',
  ADD COLUMN IF NOT EXISTS "acceptedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "autoClosedReason" TEXT;

-- Panneaux Discord « statut des recrutements ».
CREATE TABLE IF NOT EXISTS "recruitment_panels" (
  "id" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "messageId" TEXT,
  "title" TEXT NOT NULL,
  "formIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "recruitment_panels_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "recruitment_panels_guildId_idx" ON "recruitment_panels"("guildId");

ALTER TABLE "recruitment_panels"
  DROP CONSTRAINT IF EXISTS "recruitment_panels_guildId_fkey";
ALTER TABLE "recruitment_panels"
  ADD CONSTRAINT "recruitment_panels_guildId_fkey"
  FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
