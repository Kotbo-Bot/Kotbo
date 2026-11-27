-- Trames de notes de fiche de la cellule de suivi.
ALTER TABLE "wellbeing_configs" ADD COLUMN "noteTemplates" JSONB NOT NULL DEFAULT '[]';
