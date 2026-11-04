-- Rôles par bouton : « un seul rôle » devient un mode du menu, à part de la
-- bascule et de l'attribution définitive. Les menus déjà réglés le gardent.
UPDATE "reaction_role_menus" SET "buttonMode" = 'exclusive' WHERE "exclusive" = true;
ALTER TABLE "reaction_role_menus" DROP COLUMN "exclusive";
