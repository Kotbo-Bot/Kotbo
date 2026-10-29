-- Shield Update, vague 5 : délai avant sanction du honeypot et durée de sa
-- sanction (bannissement et quarantaine permanents possibles).
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "honeypotGraceSeconds" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "honeypotDurationMin" INTEGER;
