-- XP des membres à l'ouverture d'une saison : le classement de saison en est la différence.
CREATE TABLE IF NOT EXISTS "season_baselines" (
    "seasonId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "xp" INTEGER NOT NULL,

    CONSTRAINT "season_baselines_pkey" PRIMARY KEY ("seasonId","userId")
);

DO $$ BEGIN
  ALTER TABLE "season_baselines" ADD CONSTRAINT "season_baselines_seasonId_fkey"
    FOREIGN KEY ("seasonId") REFERENCES "leveling_seasons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Saisons déjà en cours : l'XP est relevée au passage de la migration, leur
-- classement repart de 0 à cet instant au lieu de rester sur l'XP totale. Leur
-- date de début devient celle du relevé, comme à toute ouverture.
INSERT INTO "season_baselines" ("seasonId", "userId", "xp")
SELECT s."id", ml."userId", ml."xp"
FROM "leveling_seasons" s
JOIN "member_levels" ml ON ml."guildId" = s."guildId"
WHERE s."status" = 'ACTIVE' AND ml."xp" > 0
ON CONFLICT DO NOTHING;

UPDATE "leveling_seasons" SET "startDate" = NOW() WHERE "status" = 'ACTIVE';
