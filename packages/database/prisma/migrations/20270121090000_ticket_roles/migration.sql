-- Rôles des tickets en listes : équipe d'assistance, équipe responsable,
-- rôles mentionnés à l'ouverture, rôles exclus.
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "ticketSupportRoleIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "ticketManagerRoleIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "ticketMentionRoleIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "ticketExcludedRoleIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "ticketClaimHidesSupport" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "ticketClaimExclusive" BOOLEAN NOT NULL DEFAULT false;

-- Historique de prise en charge et de transferts d'un ticket.
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "handlingLog" JSONB;

-- Le rôle staff unique d'avant devient le premier rôle de l'équipe d'assistance.
UPDATE "guilds"
SET "ticketSupportRoleIds" = ARRAY["ticketStaffRoleId"]
WHERE "ticketStaffRoleId" IS NOT NULL AND cardinality("ticketSupportRoleIds") = 0;
