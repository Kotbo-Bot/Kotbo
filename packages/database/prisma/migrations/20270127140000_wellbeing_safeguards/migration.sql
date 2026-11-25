-- Corbeille des dossiers de la cellule bien-être : restaurables 30 jours.
ALTER TABLE "wellbeing_cases" ADD COLUMN "deletedAt" TIMESTAMP(3),
ADD COLUMN "deletedById" TEXT,
ADD COLUMN "deletedByName" TEXT;

-- Fin anticipée (ou annulation) d'un accès d'urgence.
ALTER TABLE "wellbeing_break_glass_logs" ADD COLUMN "endedAt" TIMESTAMP(3),
ADD COLUMN "endedById" TEXT,
ADD COLUMN "endedByName" TEXT;

-- CreateIndex
CREATE INDEX "wellbeing_cases_guildId_deletedAt_idx" ON "wellbeing_cases"("guildId", "deletedAt");
