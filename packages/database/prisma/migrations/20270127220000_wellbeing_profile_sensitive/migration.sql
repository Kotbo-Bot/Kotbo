-- Notes de fiche sensibles (santé, vie privée) : 3 mois de vie, masquées jusqu'à un clic.
ALTER TABLE "wellbeing_profile_notes" ADD COLUMN "sensitive" BOOLEAN NOT NULL DEFAULT false;
