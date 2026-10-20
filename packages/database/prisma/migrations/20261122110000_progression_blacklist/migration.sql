-- Blacklist commune aux modules de progression (niveaux, RPG, économie...) :
-- membres, rôles et salons qui n'y gagnent rien et ne peuvent pas jouer.
ALTER TABLE "guilds"
  ADD COLUMN IF NOT EXISTS "progressionBlacklistUserIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "progressionBlacklistRoleIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "progressionBlacklistChannelIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
