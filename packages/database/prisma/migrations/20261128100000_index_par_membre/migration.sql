-- Deux recherches par membre qui parcouraient toute la table faute d'index.

-- La fiche membre, le profil et la détection de doubles comptes cherchent la
-- dernière arrivée d'un membre (`where guildId, userId order by joinedAt desc`).
-- Les index existants commencent par guildId puis inviterId, joinedAt ou
-- inviteCode : Postgres relisait toutes les arrivées du serveur.
CREATE INDEX IF NOT EXISTS "member_invites_guildId_userId_joinedAt_idx" ON "member_invites"("guildId", "userId", "joinedAt");

-- « Mon espace », l'arrivée sur un nouveau serveur et la page de profil publique
-- lisent les fiches d'une personne sur tous ses serveurs (`where userId`). La clé
-- unique (guildId, userId) ne sert pas sans guildId : parcours complet de la table.
CREATE INDEX IF NOT EXISTS "member_profiles_userId_idx" ON "member_profiles"("userId");
