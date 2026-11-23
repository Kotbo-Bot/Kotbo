-- Reprise des quêtes communautaires (quest_definitions) dans le moteur unique.
-- Les anciennes tables restent en place, plus alimentées : leur suppression viendra dans une
-- migration séparée, une fois la reprise vérifiée en production.

-- Définitions : l'identifiant est conservé pour que l'historique ci-dessous s'y rattache.
-- L'XP des anciennes quêtes est de l'XP de niveau, pas de l'XP RPG : elle passe dans `rewards`.
INSERT INTO "rpg_quests" (
  "id", "guildId", "name", "description", "emoji", "objective", "target", "scope", "teamMode",
  "repeatable", "windowHours", "rewardCoins", "rewardXp", "rewardClanPoints", "enabled",
  "conditions", "rewards", "createdAt", "updatedAt"
)
SELECT
  q."id", q."guildId",
  CASE
    WHEN q."rn" > 1 OR EXISTS (SELECT 1 FROM "rpg_quests" r WHERE r."guildId" = q."guildId" AND r."name" = q."name")
      THEN left(q."name", 50) || ' (' || q."rn" || ')'
    ELSE q."name"
  END,
  q."description", '📜', q."type"::text::"RpgQuestObjective", q."target", 'MEMBER', 'CLAN',
  false, CASE WHEN q."frequency"::text = 'WEEKLY' THEN 168 ELSE 24 END,
  q."rewardCoins", 0, 0, q."enabled",
  NULLIF(q."conditions"::jsonb - 'customRule', '{}'::jsonb),
  CASE WHEN q."rewardXp" > 0
    THEN jsonb_build_array(jsonb_build_object('type', 'LEVEL_XP', 'amount', q."rewardXp"))
    ELSE NULL END,
  q."createdAt", q."updatedAt"
FROM (
  SELECT d.*, row_number() OVER (PARTITION BY d."guildId", d."name" ORDER BY d."createdAt", d."id") AS "rn"
  FROM "quest_definitions" d
) q
ON CONFLICT DO NOTHING;

-- Historique payé : il alimente le succès « Terminer 50 quêtes » et le compteur du dashboard.
-- La clé de fenêtre se déduit de la date du versement, la seule fiable pour les hebdomadaires.
INSERT INTO "rpg_quest_progress" (
  "id", "guildId", "questId", "userId", "windowKey", "teamKey", "current", "target",
  "status", "completions", "completedAt", "claimedAt", "updatedAt"
)
SELECT
  'qm_' || p."id", p."guildId", p."questId", p."userId",
  floor(extract(epoch FROM coalesce(p."claimedAt", p."updatedAt")) / (CASE WHEN d."frequency"::text = 'WEEKLY' THEN 168 ELSE 24 END * 3600))::bigint::text,
  '', p."target", p."target", 'CLAIMED', 1, p."claimedAt", p."claimedAt", p."updatedAt"
FROM "quest_progress" p
JOIN "quest_definitions" d ON d."id" = p."questId"
WHERE p."status"::text = 'CLAIMED'
  AND EXISTS (SELECT 1 FROM "rpg_quests" r WHERE r."id" = p."questId")
ON CONFLICT DO NOTHING;
