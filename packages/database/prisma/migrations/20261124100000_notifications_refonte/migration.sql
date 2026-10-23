-- Refonte des notifications : type, famille, regroupement, archivage,
-- grille de préférences et file des MP. Le schéma était livré sans migration.
ALTER TABLE "notifications"
  ADD COLUMN IF NOT EXISTS "kind"       TEXT         NOT NULL DEFAULT 'system.generic',
  ADD COLUMN IF NOT EXISTS "category"   TEXT         NOT NULL DEFAULT 'system',
  ADD COLUMN IF NOT EXISTS "actorId"    TEXT,
  ADD COLUMN IF NOT EXISTS "groupKey"   TEXT,
  ADD COLUMN IF NOT EXISTS "count"      INTEGER      NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "data"       JSONB,
  ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS "notifications_userId_archivedAt_updatedAt_idx" ON "notifications"("userId", "archivedAt", "updatedAt");
CREATE INDEX IF NOT EXISTS "notifications_guildId_userId_groupKey_idx" ON "notifications"("guildId", "userId", "groupKey");

CREATE TABLE IF NOT EXISTS "notification_preferences" (
  "userId"    TEXT         NOT NULL,
  "category"  TEXT         NOT NULL,
  "dashboard" BOOLEAN      NOT NULL DEFAULT true,
  "dm"        BOOLEAN      NOT NULL DEFAULT true,
  "digest"    BOOLEAN      NOT NULL DEFAULT false,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("userId", "category")
);

CREATE TABLE IF NOT EXISTS "notification_dms" (
  "id"        TEXT         NOT NULL,
  "userId"    TEXT         NOT NULL,
  "guildId"   TEXT         NOT NULL,
  "kind"      TEXT         NOT NULL,
  "category"  TEXT         NOT NULL,
  "title"     TEXT         NOT NULL,
  "message"   TEXT         NOT NULL,
  "severity"  TEXT         NOT NULL DEFAULT 'INFO',
  "link"      TEXT,
  "digest"    BOOLEAN      NOT NULL DEFAULT false,
  "sendAfter" TIMESTAMP(3) NOT NULL,
  "claimedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_dms_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "notification_dms_sendAfter_claimedAt_idx" ON "notification_dms"("sendAfter", "claimedAt");
CREATE INDEX IF NOT EXISTS "notification_dms_userId_idx" ON "notification_dms"("userId");
