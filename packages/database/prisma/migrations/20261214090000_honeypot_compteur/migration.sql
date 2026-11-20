-- Avertissement du salon piège : texte selon la sanction et compteur de
-- comptes piégés, repris de l'historique des sanctions honeypot.
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "honeypotNoticeMessageId" TEXT;
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "honeypotShowCount" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "honeypotCatchCount" INTEGER NOT NULL DEFAULT 0;

UPDATE "guilds" g
SET "honeypotCatchCount" = s.n
FROM (
  SELECT "guildId", COUNT(DISTINCT "targetUserId")::int AS n
  FROM "sanctions"
  WHERE "reason" LIKE 'Kotbo Honeypot:%'
  GROUP BY "guildId"
) s
WHERE s."guildId" = g."id";
