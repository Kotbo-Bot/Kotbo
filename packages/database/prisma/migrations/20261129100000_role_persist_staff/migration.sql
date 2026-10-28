-- AlterTable
ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "rolePersistStaff" BOOLEAN NOT NULL DEFAULT false;
