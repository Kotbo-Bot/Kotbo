-- Tickets restés sans réponse du staff : relance automatique après un délai
-- (désactivée par défaut) et compteur des relances, lu par les statistiques.
ALTER TABLE "guilds"
  ADD COLUMN IF NOT EXISTS "ticketStaffReminderEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "ticketStaffReminderMinutes" INTEGER NOT NULL DEFAULT 60;

ALTER TABLE "tickets"
  ADD COLUMN IF NOT EXISTS "staffReminderSentAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "staffReminderCount" INTEGER NOT NULL DEFAULT 0;
