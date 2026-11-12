-- Drops jackpot : réglage par serveur, drapeau sur chaque drop pour l'annonce et l'historique.

ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "dropJackpotEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "dropJackpotChance" INTEGER NOT NULL DEFAULT 20;
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "dropJackpotMultiplier" INTEGER NOT NULL DEFAULT 5;

ALTER TABLE "drops" ADD COLUMN IF NOT EXISTS "jackpot" BOOLEAN NOT NULL DEFAULT false;
