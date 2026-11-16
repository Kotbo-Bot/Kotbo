-- Dashboard perso du bot personnalisé : la colonne ne garde plus qu'un nom
-- d'hôte, unique, vérifié par DNS avant d'être servi.

-- Les valeurs saisies jusqu'ici étaient des URL libres, jamais utilisées :
-- on n'en garde que l'hôte, en minuscules.
UPDATE "custom_bot_configs"
SET "customDashboardUrl" = NULLIF(
  lower(split_part(split_part(regexp_replace(trim("customDashboardUrl"), '^https?://', '', 'i'), '/', 1), ':', 1)),
  ''
)
WHERE "customDashboardUrl" IS NOT NULL;

-- Un hôte saisi par deux serveurs reste au premier, l'index unique l'exige.
UPDATE "custom_bot_configs" c
SET "customDashboardUrl" = NULL
WHERE c."customDashboardUrl" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "custom_bot_configs" o
    WHERE o."customDashboardUrl" = c."customDashboardUrl" AND o."guildId" < c."guildId"
  );

ALTER TABLE "custom_bot_configs" ADD COLUMN IF NOT EXISTS "customDomainVerifiedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "custom_bot_configs_customDashboardUrl_key"
  ON "custom_bot_configs"("customDashboardUrl");
