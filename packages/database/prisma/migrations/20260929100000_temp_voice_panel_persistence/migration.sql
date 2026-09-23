-- Salons vocaux temporaires : ce que le panneau gardait en memoire et perdait
-- a chaque redemarrage.
--
-- `renameHistory` : le quota de renommage de Discord (deux par dix minutes et
-- par salon) que le bouton annonce. Perdu, il annoncait un credit inexistant.
-- `accessRequests` : les demandes en attente et les silences apres refus. Perdu,
-- quelqu'un qui venait d'etre refuse pouvait redemander aussitot.
--
-- Les deux meurent avec le salon : la ligne est supprimee en cascade.
ALTER TABLE "temp_voice_channels"
  ADD COLUMN IF NOT EXISTS "renameHistory" JSONB;

ALTER TABLE "temp_voice_channels"
  ADD COLUMN IF NOT EXISTS "accessRequests" JSONB;
