-- Relances en message privé aux administrateurs : reprendre une configuration
-- laissée en plan, une étape utile restante, ce que Kotbo a fait pendant une
-- longue absence. Chaque relance part une seule fois par serveur ; le bouton du
-- message les coupe pour le serveur.
-- Rejouable : chaque ajout est conditionnel.

ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "lifecycleRemindersEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "lifecycleRemindersSent" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "lastLifecycleReminderAt" TIMESTAMP(3);
