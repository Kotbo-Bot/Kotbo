-- Rôles par bouton : texte du message réglable ; vide, le bot garde son texte par défaut.
ALTER TABLE "reaction_role_menus" ADD COLUMN "description" TEXT;
