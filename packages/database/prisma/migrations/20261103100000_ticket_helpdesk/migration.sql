-- Centre de support : priorité, étiquettes, tour de parole et objectifs de service.
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "lastMemberMessageAt" TIMESTAMP(3);
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "lastStaffMessageAt" TIMESTAMP(3);
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "priority" TEXT NOT NULL DEFAULT 'NORMAL';
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];
CREATE INDEX IF NOT EXISTS "tickets_guildId_claimedById_status_idx" ON "tickets"("guildId", "claimedById", "status");

-- Les tickets en cours repartent de leur dernier état connu : la première
-- réponse tient lieu de dernier message du staff, l'ouverture de dernier
-- message de l'auteur.
UPDATE "tickets" SET "lastMemberMessageAt" = "createdAt" WHERE "lastMemberMessageAt" IS NULL;
UPDATE "tickets" SET "lastStaffMessageAt" = "firstResponseAt" WHERE "lastStaffMessageAt" IS NULL AND "firstResponseAt" IS NOT NULL;

ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "ticketSlaFirstResponseMinutes" INTEGER;
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "ticketSlaResolutionHours" INTEGER;
