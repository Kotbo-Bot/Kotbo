-- Rôles par bouton : nombre de membres affiché sur chaque bouton, au choix du staff.
ALTER TABLE "reaction_role_menus" ADD COLUMN "showCounts" BOOLEAN NOT NULL DEFAULT false;
