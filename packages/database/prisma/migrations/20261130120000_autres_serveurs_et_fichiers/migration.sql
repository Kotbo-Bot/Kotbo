-- Shield Update, vague 3 : filtres Automod « Autres serveurs » (invitations,
-- messages transférés, tags de serveur) et « Extensions de fichiers ».
-- Rejouable : chaque ajout est conditionnel.

ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "otherInvitesMode" TEXT NOT NULL DEFAULT 'OFF';
ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "otherFriendInvites" TEXT NOT NULL DEFAULT 'FOLLOW';
ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "otherForwardsMode" TEXT NOT NULL DEFAULT 'OFF';
ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "otherTagsMode" TEXT NOT NULL DEFAULT 'OFF';
ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "otherServers" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "otherSanction" TEXT NOT NULL DEFAULT 'DELETE';
ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "otherDurationMin" INTEGER DEFAULT 60;
ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "fileFilterMode" TEXT NOT NULL DEFAULT 'OFF';
ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "fileGroups" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "fileExtensions" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "fileRejectCorrupted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "fileSanction" TEXT NOT NULL DEFAULT 'DELETE';
ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "fileDurationMin" INTEGER DEFAULT 60;

CREATE TABLE IF NOT EXISTS "file_filter_rules" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL DEFAULT 'CHANNEL',
    "mode" TEXT NOT NULL DEFAULT 'BLACKLIST',
    "groups" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "extensions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_filter_rules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "file_filter_rules_guildId_targetId_key" ON "file_filter_rules"("guildId", "targetId");

DO $$ BEGIN
  ALTER TABLE "file_filter_rules" ADD CONSTRAINT "file_filter_rules_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
