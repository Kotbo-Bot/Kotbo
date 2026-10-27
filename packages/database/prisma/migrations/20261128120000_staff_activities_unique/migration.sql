-- La contrainte unique figurait dans le schéma sans jamais avoir de migration :
-- sur une base montée par migrations, l'upsert d'activité du staff échouait
-- (42P10, aucune contrainte ne correspondait au ON CONFLICT).

-- Avant de poser la contrainte, fusionne les éventuels doublons : les
-- compteurs sont additionnés sur la ligne la plus ancienne, les autres partent.
UPDATE "staff_activities" k
SET "messageCount" = d.messages, "voiceMinutes" = d.voice
FROM (
  SELECT MIN("id") AS keep_id, SUM("messageCount") AS messages, SUM("voiceMinutes") AS voice
  FROM "staff_activities"
  GROUP BY "guildId", "staffUserId", "activityDate"
  HAVING COUNT(*) > 1
) d
WHERE k."id" = d.keep_id;

DELETE FROM "staff_activities" a
USING "staff_activities" b
WHERE a."guildId" = b."guildId"
  AND a."staffUserId" = b."staffUserId"
  AND a."activityDate" = b."activityDate"
  AND a."id" > b."id";

CREATE UNIQUE INDEX IF NOT EXISTS "staff_activities_guildId_staffUserId_activityDate_key"
  ON "staff_activities"("guildId", "staffUserId", "activityDate");

CREATE INDEX IF NOT EXISTS "staff_activities_guildId_activityDate_idx"
  ON "staff_activities"("guildId", "activityDate");
