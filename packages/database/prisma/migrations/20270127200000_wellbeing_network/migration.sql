-- Référents partagés entre les cellules d'un réseau de serveurs.
ALTER TABLE "wellbeing_configs" ADD COLUMN "networkPool" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "wellbeing_cases" ADD COLUMN "networkReferentId" TEXT,
ADD COLUMN "networkReferentGuildId" TEXT;

CREATE INDEX "wellbeing_cases_networkReferentId_idx" ON "wellbeing_cases"("networkReferentId");
