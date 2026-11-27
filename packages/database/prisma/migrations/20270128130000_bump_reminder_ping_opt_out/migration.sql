-- Rappel de bump : refus individuel du ping (`/bump-ping desactiver`).
ALTER TABLE "member_profiles" ADD COLUMN IF NOT EXISTS "bumpReminderPingOptOut" BOOLEAN NOT NULL DEFAULT false;
