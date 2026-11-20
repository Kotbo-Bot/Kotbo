-- Drops : règles de ramassage facultatives (plafond sur 24 h, ancienneté, rôle requis).
-- Objet vide par défaut : aucun serveur ne voit son comportement changer.

ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "dropClaimRules" JSONB NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS "drop_claims_guildId_userId_createdAt_idx" ON "drop_claims"("guildId", "userId", "createdAt");
