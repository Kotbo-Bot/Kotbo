-- L'upsert du bot perso (`cb-<serveur>`) s'appuie sur l'unicité du slug : sans
-- index unique, Postgres refuse l'ON CONFLICT (42P10) et le démarrage échoue.

-- Un slug en double reste à la plus ancienne instance, l'index unique l'exige.
DELETE FROM "whitelabel_instances" w
USING "whitelabel_instances" o
WHERE w."slug" = o."slug"
  AND (w."createdAt", w."id") > (o."createdAt", o."id")
  AND NOT EXISTS (SELECT 1 FROM "guilds" g WHERE g."instanceId" = w."id");

CREATE UNIQUE INDEX IF NOT EXISTS "whitelabel_instances_slug_key"
  ON "whitelabel_instances"("slug");
