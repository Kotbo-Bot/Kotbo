-- Starlight : extrait et première image du message, pour la galerie du dashboard.
ALTER TABLE "starboard_entries" ADD COLUMN IF NOT EXISTS "excerpt" TEXT;
ALTER TABLE "starboard_entries" ADD COLUMN IF NOT EXISTS "imageUrl" TEXT;

-- Galerie : la plus récente d'abord, ou au meilleur score.
CREATE INDEX IF NOT EXISTS "starboard_entries_guildId_createdAt_idx" ON "starboard_entries"("guildId", "createdAt");
CREATE INDEX IF NOT EXISTS "starboard_entries_guildId_peakScore_idx" ON "starboard_entries"("guildId", "peakScore");
