-- Suppression du Daily Algo : le module n'est plus utilise. Tables, types et colonnes disparaissent
-- avec leurs donnees (problemes, defis, soumissions, semaines, recompenses, points bonus).

DROP TABLE IF EXISTS "daily_algo_bonus_points" CASCADE;
DROP TABLE IF EXISTS "daily_algo_weekly_rewards" CASCADE;
DROP TABLE IF EXISTS "daily_algo_weeks" CASCADE;
DROP TABLE IF EXISTS "daily_algo_submissions" CASCADE;
DROP TABLE IF EXISTS "daily_algo_runs" CASCADE;
DROP TABLE IF EXISTS "daily_algo_problems" CASCADE;

DROP TYPE IF EXISTS "DailyAlgoSubmissionStatus";
DROP TYPE IF EXISTS "DailyAlgoWeekStatus";

ALTER TABLE "guilds"
  DROP COLUMN IF EXISTS "dailyAlgoEnabled",
  DROP COLUMN IF EXISTS "dailyAlgoChannelId",
  DROP COLUMN IF EXISTS "dailyAlgoValidationChannelId",
  DROP COLUMN IF EXISTS "dailyAlgoTime",
  DROP COLUMN IF EXISTS "dailyAlgoTimezone",
  DROP COLUMN IF EXISTS "dailyAlgoParticipationPoints",
  DROP COLUMN IF EXISTS "dailyAlgoWeekendMultiplier",
  DROP COLUMN IF EXISTS "dailyAlgoWeeklyRewardsEnabled",
  DROP COLUMN IF EXISTS "dailyAlgoWeekRole1Id",
  DROP COLUMN IF EXISTS "dailyAlgoWeekRole2Id",
  DROP COLUMN IF EXISTS "dailyAlgoWeekRole3Id",
  DROP COLUMN IF EXISTS "dailyAlgoWeekRoleRotate",
  DROP COLUMN IF EXISTS "dailyAlgoWeekXp1",
  DROP COLUMN IF EXISTS "dailyAlgoWeekXp2",
  DROP COLUMN IF EXISTS "dailyAlgoWeekXp3",
  DROP COLUMN IF EXISTS "dailyAlgoWeekParticipationXp",
  DROP COLUMN IF EXISTS "dailyAlgoWeekAnnouncementChannelId",
  DROP COLUMN IF EXISTS "dailyAlgoSanctionType",
  DROP COLUMN IF EXISTS "dailyAlgoSanctionWeight",
  DROP COLUMN IF EXISTS "dailyAlgoSanctionDurationMinutes",
  DROP COLUMN IF EXISTS "clanPointsFromDailyAlgo",
  DROP COLUMN IF EXISTS "clanPointsFromDailyAlgoRate",
  DROP COLUMN IF EXISTS "clanPointsDailyAlgoTop1",
  DROP COLUMN IF EXISTS "clanPointsDailyAlgoTop2",
  DROP COLUMN IF EXISTS "clanPointsDailyAlgoTop3";

ALTER TABLE "api_keys" ALTER COLUMN "permissions" SET DEFAULT ARRAY[]::TEXT[];

DELETE FROM "dashboard_feature_configs" WHERE "featureKey" IN ('daily_algo', 'dailyalgo');
