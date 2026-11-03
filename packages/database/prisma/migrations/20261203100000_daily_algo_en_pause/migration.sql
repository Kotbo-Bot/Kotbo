-- Daily Algo en pause : les serveurs qui l'avaient encore allume sont eteints.
-- Rien n'est supprime (problemes, soumissions, semaines, reglages restent en
-- base) ; seuls les interrupteurs passent a faux. La garde du bot le tient deja
-- eteint, mais plusieurs balayages lisent la colonne directement.

UPDATE "guilds" SET "dailyAlgoEnabled" = false WHERE "dailyAlgoEnabled" = true;

UPDATE "guilds" SET "clanPointsFromDailyAlgo" = false WHERE "clanPointsFromDailyAlgo" = true;

UPDATE "dashboard_feature_configs"
SET "enabled" = false, "updatedAt" = CURRENT_TIMESTAMP
WHERE "featureKey" IN ('daily_algo', 'dailyalgo') AND "enabled" = true;
