-- Suggestions : catégorie et récompense versée à l'auteur.
ALTER TABLE "suggestions" ADD COLUMN IF NOT EXISTS "category" TEXT;
ALTER TABLE "suggestions" ADD COLUMN IF NOT EXISTS "xpGranted" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "suggestions" ADD COLUMN IF NOT EXISTS "coinsGranted" INTEGER NOT NULL DEFAULT 0;

-- Réglages : récompense, catégories, votants visibles du staff.
ALTER TABLE "suggestion_configs" ADD COLUMN IF NOT EXISTS "rewardXp" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "suggestion_configs" ADD COLUMN IF NOT EXISTS "rewardCoins" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "suggestion_configs" ADD COLUMN IF NOT EXISTS "categories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "suggestion_configs" ADD COLUMN IF NOT EXISTS "showVoters" BOOLEAN NOT NULL DEFAULT false;
