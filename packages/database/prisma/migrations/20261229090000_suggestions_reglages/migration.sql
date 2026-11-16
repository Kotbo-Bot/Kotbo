-- Réglages du module Suggestions, une ligne par serveur.
CREATE TABLE IF NOT EXISTS "suggestion_configs" (
    "guildId" TEXT NOT NULL,
    "requireComment" BOOLEAN NOT NULL DEFAULT true,
    "voteWhileApproved" BOOLEAN NOT NULL DEFAULT false,
    "allowedRoleIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suggestion_configs_pkey" PRIMARY KEY ("guildId")
);

DO $$ BEGIN
  ALTER TABLE "suggestion_configs" ADD CONSTRAINT "suggestion_configs_guildId_fkey"
    FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- File d'attente et filtre par statut du dashboard.
CREATE INDEX IF NOT EXISTS "suggestions_guildId_status_createdAt_idx" ON "suggestions"("guildId", "status", "createdAt");
