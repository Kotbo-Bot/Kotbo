-- Salons vocaux temporaires : visibilité propre à chaque salon ('tous' | 'acces'
-- | 'prive'; NULL = défaut du serveur) et réglages enregistrés par le membre pour
-- ses salons. Colonnes nullables sans remplissage : rien n'a encore été choisi.
ALTER TABLE "temp_voice_channels"
  ADD COLUMN IF NOT EXISTS "visibility" TEXT;

ALTER TABLE "member_profiles"
  ADD COLUMN IF NOT EXISTS "tempVoiceSavedSettings" JSONB;
