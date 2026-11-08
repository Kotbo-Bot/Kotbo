-- Shield Update, vague 1 : sanction Jail (quarantaine par rôle) et Kotbo Vision v2
-- (empreinte multi-hash, catalogues personnalisés, file de vérification).
-- Rejouable : chaque ajout est conditionnel.

ALTER TYPE "SanctionType" ADD VALUE IF NOT EXISTS 'JAIL';

ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "jailRoleId" TEXT;
ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "jailChannelId" TEXT;
ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "jailStripRoles" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "visionEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "visionSanction" TEXT NOT NULL DEFAULT 'TIMEOUT';
ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "visionDurationMin" INTEGER DEFAULT 1440;
ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "visionReviewChannelId" TEXT;
ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "visionNotifyMember" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "scam_image_hashes" ADD COLUMN IF NOT EXISTS "fingerprint" TEXT;
ALTER TABLE "scam_image_hashes" ADD COLUMN IF NOT EXISTS "thumb" TEXT;
ALTER TABLE "scam_image_hashes" ADD COLUMN IF NOT EXISTS "listId" TEXT;
ALTER TABLE "scam_image_hashes" ADD COLUMN IF NOT EXISTS "parentId" TEXT;
ALTER TABLE "scam_image_hashes" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'BLOCKED';
ALTER TABLE "scam_image_hashes" ADD COLUMN IF NOT EXISTS "hits" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "scam_image_hashes" ADD COLUMN IF NOT EXISTS "lastSeenAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "member_jails" (
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sanctionId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "roleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reason" TEXT,
    "releaseAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_jails_pkey" PRIMARY KEY ("guildId","userId")
);

CREATE TABLE IF NOT EXISTS "vision_lists" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "reviewChannelId" TEXT,
    "sanction" TEXT,
    "durationMin" INTEGER,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vision_lists_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "vision_reviews" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "listId" TEXT,
    "matchId" TEXT,
    "score" DOUBLE PRECISION NOT NULL,
    "authorId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "thumb" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reviewMessageId" TEXT,
    "handledBy" TEXT,
    "handledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vision_reviews_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "member_jails_releaseAt_idx" ON "member_jails"("releaseAt");
CREATE INDEX IF NOT EXISTS "member_jails_guildId_source_idx" ON "member_jails"("guildId", "source");
CREATE UNIQUE INDEX IF NOT EXISTS "vision_lists_guildId_name_key" ON "vision_lists"("guildId", "name");
CREATE INDEX IF NOT EXISTS "vision_reviews_guildId_status_idx" ON "vision_reviews"("guildId", "status");
CREATE INDEX IF NOT EXISTS "vision_reviews_guildId_sha256_idx" ON "vision_reviews"("guildId", "sha256");
CREATE INDEX IF NOT EXISTS "scam_image_hashes_listId_idx" ON "scam_image_hashes"("listId");

DO $$ BEGIN
  ALTER TABLE "member_jails" ADD CONSTRAINT "member_jails_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "vision_lists" ADD CONSTRAINT "vision_lists_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "vision_reviews" ADD CONSTRAINT "vision_reviews_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "scam_image_hashes" ADD CONSTRAINT "scam_image_hashes_listId_fkey" FOREIGN KEY ("listId") REFERENCES "vision_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
