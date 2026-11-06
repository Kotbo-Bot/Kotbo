-- Rôles-boutons : rôles pris et retirés depuis les panneaux, par jour, menu et rôle.
CREATE TABLE IF NOT EXISTS "reaction_role_daily_stats" (
    "guildId" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "menuId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "added" INTEGER NOT NULL DEFAULT 0,
    "removed" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "reaction_role_daily_stats_pkey" PRIMARY KEY ("guildId", "dateKey", "menuId", "roleId")
);
DO $$ BEGIN
    ALTER TABLE "reaction_role_daily_stats" ADD CONSTRAINT "reaction_role_daily_stats_guildId_fkey"
        FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
