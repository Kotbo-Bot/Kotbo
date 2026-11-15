-- Salon d'annonce de l'ouverture et de la clôture d'une saison.
ALTER TABLE "leveling_seasons" ADD COLUMN IF NOT EXISTS "announceChannelId" TEXT;
