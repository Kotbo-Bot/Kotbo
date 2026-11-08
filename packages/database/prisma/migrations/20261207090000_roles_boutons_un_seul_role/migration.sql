-- Rôles par bouton : menu « un seul rôle », où en prendre un retire les autres.
ALTER TABLE "reaction_role_menus" ADD COLUMN "exclusive" BOOLEAN NOT NULL DEFAULT false;
