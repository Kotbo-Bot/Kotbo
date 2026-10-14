-- Salons vocaux temporaires : passation d'un salon dont le proprietaire part.
-- Ajout de colonnes avec defaut, rien n'est reecrit ; chaque defaut garde la
-- suppression d'un salon vide, comme avant.
--
-- `handoverDmEnabled` / `handoverDelaySeconds` : le proprietaire qui part
--   recoit en MP le menu des presents, valable 30 s par defaut.
-- `claimEmbedEnabled` : sans choix, un message « Recuperer le salon » est
--   poste dans le chat du salon.
-- `claimWho` present = tout membre en vocal peut recuperer le salon.
-- `moderatorClaimOverride` : le staff peut annuler la reclamation d'un membre.
-- `deleteWhenEmpty` : un salon vide est supprime (comportement d'avant).
ALTER TABLE "temp_voice_mod_permissions_configs"
  ADD COLUMN IF NOT EXISTS "handoverDmEnabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "temp_voice_mod_permissions_configs"
  ADD COLUMN IF NOT EXISTS "handoverDelaySeconds" INTEGER NOT NULL DEFAULT 30;

ALTER TABLE "temp_voice_mod_permissions_configs"
  ADD COLUMN IF NOT EXISTS "claimEmbedEnabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "temp_voice_mod_permissions_configs"
  ADD COLUMN IF NOT EXISTS "claimWho" TEXT NOT NULL DEFAULT 'present';

ALTER TABLE "temp_voice_mod_permissions_configs"
  ADD COLUMN IF NOT EXISTS "moderatorClaimOverride" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "temp_voice_mod_permissions_configs"
  ADD COLUMN IF NOT EXISTS "deleteWhenEmpty" BOOLEAN NOT NULL DEFAULT true;
