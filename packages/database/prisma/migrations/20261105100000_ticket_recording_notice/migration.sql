-- Avertissement d'enregistrement avant la création d'un ticket.
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "ticketRecordingNoticeEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "ticketRecordingNoticeSeconds" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "ticketRecordingNoticeText" TEXT;
