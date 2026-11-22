-- Audit de la base : taille, index inutiles, bloat, requetes lentes.
-- Lecture seule. Lancer sur la prod :
--   docker exec -i kotbo-postgres psql -U kotbo -d kotbo < scripts/db-audit.sql
-- Les compteurs d'index repartent de zero apres un redemarrage ou un
-- pg_stat_reset() : ne tirer de conclusions qu'apres plusieurs semaines d'uptime.

\echo '== 1. Taille totale de la base'
SELECT pg_size_pretty(pg_database_size(current_database())) AS taille;

\echo '== 2. 30 plus grosses tables (donnees / index / TOAST)'
SELECT c.relname AS table,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
       pg_size_pretty(pg_relation_size(c.oid)) AS donnees,
       pg_size_pretty(pg_indexes_size(c.oid)) AS index,
       pg_size_pretty(COALESCE(pg_total_relation_size(c.reltoastrelid), 0)) AS toast,
       s.n_live_tup AS lignes_vivantes
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE c.relkind = 'r'
ORDER BY pg_total_relation_size(c.oid) DESC
LIMIT 30;

\echo '== 3. Index jamais utilises (hors cles primaires et uniques), du plus gros au plus petit'
SELECT s.relname AS table, s.indexrelname AS index,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS taille, s.idx_scan AS lectures
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0 AND NOT i.indisunique AND NOT i.indisprimary
ORDER BY pg_relation_size(s.indexrelid) DESC
LIMIT 40;

\echo '== 4. Tables avec beaucoup de lignes mortes (candidates a VACUUM / pg_repack)'
SELECT relname AS table, n_live_tup AS vivantes, n_dead_tup AS mortes,
       round(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 1) AS pct_mortes,
       last_autovacuum
FROM pg_stat_user_tables
WHERE n_dead_tup > 10000
ORDER BY n_dead_tup DESC
LIMIT 20;

\echo '== 5. Tables lues en sequentiel de facon repetee (index manquant probable)'
SELECT relname AS table, seq_scan, seq_tup_read, idx_scan,
       pg_size_pretty(pg_relation_size(relid)) AS taille
FROM pg_stat_user_tables
WHERE seq_scan > 100 AND pg_relation_size(relid) > 10 * 1024 * 1024
ORDER BY seq_tup_read DESC
LIMIT 20;

\echo '== 6. Requetes les plus couteuses (necessite pg_stat_statements)'
SELECT round(total_exec_time::numeric / 1000, 1) AS secondes_total,
       calls, round(mean_exec_time::numeric, 2) AS ms_moyenne,
       rows, left(regexp_replace(query, '\s+', ' ', 'g'), 140) AS requete
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 20;
