-- État du dashboard : les journaux hors « Discord », triés par date.
--
-- `eventType <> 'Discord'` ne peut pas parcourir l'index (guildId, eventType,
-- dateIso) dans l'ordre des dates : Postgres remontait tout l'historique du
-- serveur par (guildId, dateIso) et filtrait ligne à ligne. Mesuré en
-- production sur le plus gros serveur : 157 596 lignes écartées pour 202
-- gardées, 1,07 s et 113 Mo lus à chaque ouverture, de quoi vider à lui seul
-- les 128 Mo de cache partagé de la base. Ces journaux pèsent ~1 % de la table :
-- un index partiel ne porte que sur eux.
--
-- Partiel, donc absent du schéma Prisma, comme `guilds_accessExpiresAt_idx`.
CREATE INDEX IF NOT EXISTS "dashboard_audit_logs_guildId_dateIso_hors_discord_idx"
    ON "dashboard_audit_logs"("guildId", "dateIso")
    WHERE "eventType" <> 'Discord';

-- La table n'avait jamais été analysée : le planificateur l'estimait à 24 000
-- lignes pour plus de 600 000 réelles.
ANALYZE "dashboard_audit_logs";
