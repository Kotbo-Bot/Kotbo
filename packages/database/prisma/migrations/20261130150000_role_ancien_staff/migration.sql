-- Rôle Discord donné aux membres qui quittent le staff.

ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "formerStaffRoleId" TEXT;
