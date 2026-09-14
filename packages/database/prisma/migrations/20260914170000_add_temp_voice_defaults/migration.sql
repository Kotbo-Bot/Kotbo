-- Politique de creation des salons vocaux temporaires (places, verrouillage,
-- roles autorises d'office, chat texte, pouvoirs du proprietaire).
-- NULL = comportement historique : le service applique alors les valeurs par
-- defaut, identiques a ce qui etait code en dur.

ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "tempVoiceDefaults" JSONB;

-- Les salons d'un serveur sont lus ensemble (dashboard, balayage de demarrage).
CREATE INDEX IF NOT EXISTS "temp_voice_channels_guildId_idx" ON "temp_voice_channels"("guildId");
