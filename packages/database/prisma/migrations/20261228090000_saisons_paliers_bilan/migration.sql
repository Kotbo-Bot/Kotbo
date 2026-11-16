-- Paliers d'XP récompensés et bilan chiffré figé à la clôture.
ALTER TABLE "leveling_seasons" ADD COLUMN IF NOT EXISTS "tiers" JSONB;
ALTER TABLE "leveling_seasons" ADD COLUMN IF NOT EXISTS "stats" JSONB;
