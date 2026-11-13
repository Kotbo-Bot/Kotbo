import prisma from './db.js';
import { logger } from './logger.js';

let dashboardSchemaPatched = false;
let serverTagSchemaPatched = false;

/** Colonnes requises par getGuildState / getOrCreateRuntime (migration 20260601120000). */
export async function ensureDashboardSchemaPatches(): Promise<void> {
  if (dashboardSchemaPatched) return;

  try {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "dashboard_settings"
        ADD COLUMN IF NOT EXISTS "commandRestrictions" JSONB,
        ADD COLUMN IF NOT EXISTS "sidebarFavorites" TEXT[] DEFAULT ARRAY[]::TEXT[];
      ALTER TABLE "dashboard_audit_logs"
        ADD COLUMN IF NOT EXISTS "channelId" TEXT;
    `);
    dashboardSchemaPatched = true;
  } catch (error) {
    logger.warn('SchemaPatches', `Dashboard schema patch failed: ${String(error)}`);
  }

  await ensureServerTagSchemaPatches();
}

/** Colonnes et table requises par le suivi des tags de serveur et le registre externe. */
export async function ensureServerTagSchemaPatches(): Promise<void> {
  if (serverTagSchemaPatched) return;

  try {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "member_profiles"
        ADD COLUMN IF NOT EXISTS "primaryGuildId" TEXT,
        ADD COLUMN IF NOT EXISTS "primaryGuildTag" TEXT,
        ADD COLUMN IF NOT EXISTS "primaryGuildBadge" TEXT,
        ADD COLUMN IF NOT EXISTS "primaryGuildUpdatedAt" TIMESTAMP(3);
      CREATE INDEX IF NOT EXISTS "member_profiles_guildId_primaryGuildId_idx"
        ON "member_profiles"("guildId", "primaryGuildId");
      CREATE TABLE IF NOT EXISTS "discord_external_guilds" (
        "guildId" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "icon" TEXT,
        "description" TEXT,
        "memberCount" INTEGER,
        "onlineCount" INTEGER,
        "tag" TEXT,
        "badge" TEXT,
        "source" TEXT NOT NULL DEFAULT 'tag',
        "botPresent" BOOLEAN NOT NULL DEFAULT false,
        "botLeftAt" TIMESTAMP(3),
        "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "resolvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "discord_external_guilds_pkey" PRIMARY KEY ("guildId")
      );
      CREATE INDEX IF NOT EXISTS "discord_external_guilds_botPresent_botLeftAt_idx"
        ON "discord_external_guilds"("botPresent", "botLeftAt");
    `);
    serverTagSchemaPatched = true;
  } catch (error) {
    logger.warn('SchemaPatches', `Server tag schema patch failed: ${String(error)}`);
  }
}
