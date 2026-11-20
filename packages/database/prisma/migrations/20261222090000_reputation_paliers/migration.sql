-- Salon d'annonce des paliers de réputation.
ALTER TABLE "reputation_configs" ADD COLUMN IF NOT EXISTS "announceChannelId" TEXT;

-- Paliers : un rôle à partir d'un total de réputation reçue.
CREATE TABLE IF NOT EXISTS "reputation_tiers" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "threshold" INTEGER NOT NULL,
    "roleId" TEXT NOT NULL,

    CONSTRAINT "reputation_tiers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "reputation_tiers_guildId_threshold_key" ON "reputation_tiers"("guildId", "threshold");
CREATE UNIQUE INDEX IF NOT EXISTS "reputation_tiers_guildId_roleId_key" ON "reputation_tiers"("guildId", "roleId");

DO $$ BEGIN
  ALTER TABLE "reputation_tiers" ADD CONSTRAINT "reputation_tiers_guildId_fkey"
    FOREIGN KEY ("guildId") REFERENCES "reputation_configs"("guildId") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
