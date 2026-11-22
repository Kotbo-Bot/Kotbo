-- Destination de la relance du staff : ticket, notification du dashboard ou salon dédié.
ALTER TABLE "guilds"
  ADD COLUMN IF NOT EXISTS "ticketStaffReminderTarget" TEXT NOT NULL DEFAULT 'TICKET',
  ADD COLUMN IF NOT EXISTS "ticketStaffReminderChannelId" TEXT;
