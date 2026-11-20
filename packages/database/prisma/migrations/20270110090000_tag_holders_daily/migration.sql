-- Porteurs du tag du serveur, relevés chaque soir (null = jour non mesuré).
ALTER TABLE "guild_daily_stats" ADD COLUMN IF NOT EXISTS "tagHolders" INTEGER;
