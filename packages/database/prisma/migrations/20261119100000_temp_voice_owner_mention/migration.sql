-- Salons vocaux temporaires : ou placer la mention qui notifie le proprietaire
-- a la creation du salon. Ajout d'une colonne avec defaut, rien n'est reecrit ;
-- le defaut 'panel' garde la mention dans le panneau, comme avant.
--   panel   = dans le panneau de gestion (comportement d'avant)
--   message = dans un message distinct au-dessus du panneau
--   none    = aucune mention
ALTER TABLE "temp_voice_mod_permissions_configs"
  ADD COLUMN IF NOT EXISTS "ownerMentionPlacement" TEXT NOT NULL DEFAULT 'panel';
