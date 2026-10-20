-- Salons vocaux temporaires : membres pour lesquels un propriétaire a choisi
-- « Ne plus demander » au MP qui propose d'appliquer un changement de mode
-- d'écriture à leur exception (["<userId>", ...]). Colonne nullable sans
-- remplissage : personne n'a encore fait ce choix.
ALTER TABLE "member_profiles"
  ADD COLUMN IF NOT EXISTS "tempVoiceWriteNoAsk" JSONB;
