-- Salons vocaux temporaires : exceptions d'ecriture par membre, posees depuis
-- la fiche du panneau ({ "<userId>": true | false }). Colonne nullable sans
-- remplissage : un salon existant n'a aucune exception.
ALTER TABLE "temp_voice_channels"
  ADD COLUMN IF NOT EXISTS "writeExceptions" JSONB;
