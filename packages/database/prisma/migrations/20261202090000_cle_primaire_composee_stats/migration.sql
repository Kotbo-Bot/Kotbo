-- Tables de statistiques : la clé unique devient la clé primaire.
--
-- Ces tables comptent une ligne par serveur et par jour (et par salon, membre,
-- paire de membres...) : ce sont elles qui grossissent avec le nombre de
-- serveurs, donc avec le passage en gratuit. Chacune portait un `id` cuid que
-- rien ne lisait, plus l'index de sa clé primaire, en double de la clé unique
-- qui sert toutes les lectures et toutes les écritures. On garde la clé
-- unique, promue en clé primaire, et on retire `id` et son index : mêmes
-- colonnes de données, une colonne et un index de moins par ligne.
--
-- Le flush des analytics écrit désormais en `INSERT ... ON CONFLICT ON
-- CONSTRAINT "<table>_pkey"`, qui a besoin de cette clé primaire.
--
-- PRIMARY KEY USING INDEX reprend l'index unique existant sans le
-- reconstruire (les colonnes sont déjà NOT NULL) : verrou bref, pas de
-- parcours de table. Les noms d'index varient selon que la table vient de
-- `db push` ou d'une migration, d'où leur recherche dans le catalogue.
-- Idempotent : une table déjà sans `id` est ignorée.

DO $$
DECLARE
  t text;
  unique_idx text;
  unique_count int;
  old_pkey text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'guild_daily_stats',
    'channel_daily_stats',
    'guild_word_stats',
    'message_content_daily_stats',
    'content_item_daily_stats',
    'guild_hourly_stats',
    'member_daily_stats',
    'command_usage_daily_stats',
    'member_interaction_daily_stats',
    'channel_response_daily_stats',
    'aegis_hourly_stats',
    'aegis_member_daily_stats',
    'site_daily_stats',
    'dashboard_telemetry_daily_stats'
  ] LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = t AND column_name = 'id'
    );

    SELECT count(*), min(i.relname) INTO unique_count, unique_idx
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class c ON c.oid = x.indrelid
    WHERE c.relname = t
      AND c.relnamespace = current_schema()::regnamespace
      AND x.indisunique AND NOT x.indisprimary;

    IF unique_count <> 1 THEN
      RAISE EXCEPTION '% : % index unique(s) trouvé(s), 1 attendu', t, unique_count;
    END IF;

    SELECT conname INTO old_pkey
    FROM pg_constraint
    WHERE conrelid = format('%I', t)::regclass AND contype = 'p';

    IF old_pkey IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, old_pkey);
    END IF;
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I PRIMARY KEY USING INDEX %I', t, t || '_pkey', unique_idx);
    EXECUTE format('ALTER TABLE %I DROP COLUMN "id"', t);
  END LOOP;
END $$;

-- Index préfixes de la nouvelle clé primaire : ils ne servent aucune lecture
-- que la clé ne serve déjà, mais chaque flush les maintenait.
DROP INDEX IF EXISTS "guild_word_stats_guildId_dateKey_idx";
DROP INDEX IF EXISTS "member_interaction_daily_stats_guildId_dateKey_idx";
DROP INDEX IF EXISTS "channel_response_daily_stats_guildId_dateKey_idx";
DROP INDEX IF EXISTS "command_usage_daily_stats_guildId_dateKey_idx";
DROP INDEX IF EXISTS "aegis_hourly_stats_guildId_dateKey_idx";
