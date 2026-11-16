-- Starlight : gains de l'auteur, paliers de rôles, message privé.
ALTER TABLE "starboard_configs" ADD COLUMN IF NOT EXISTS "rewardXp" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "starboard_configs" ADD COLUMN IF NOT EXISTS "rewardCoins" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "starboard_configs" ADD COLUMN IF NOT EXISTS "tiers" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "starboard_configs" ADD COLUMN IF NOT EXISTS "notifyAuthor" BOOLEAN NOT NULL DEFAULT false;

-- Gains réellement versés, pour les reprendre au retrait par le staff.
ALTER TABLE "starboard_entries" ADD COLUMN IF NOT EXISTS "rewardedAt" TIMESTAMP(3);
ALTER TABLE "starboard_entries" ADD COLUMN IF NOT EXISTS "xpGranted" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "starboard_entries" ADD COLUMN IF NOT EXISTS "coinsGranted" INTEGER NOT NULL DEFAULT 0;

-- Classement des auteurs et paliers : messages d'un membre par serveur.
CREATE INDEX IF NOT EXISTS "starboard_entries_guildId_authorId_idx" ON "starboard_entries"("guildId", "authorId");

-- Messages passés à la une avant les récompenses : considérés comme déjà
-- traités. Sans cela, la prochaine republication de l'un d'eux (score qui
-- repasse le seuil, republication supprimée à la main) verserait des gains,
-- enverrait un message privé et lancerait les workflows pour un vieux message.
UPDATE "starboard_entries"
   SET "rewardedAt" = COALESCE("postedAt", "createdAt")
 WHERE "rewardedAt" IS NULL
   AND "blockedAt" IS NULL;
