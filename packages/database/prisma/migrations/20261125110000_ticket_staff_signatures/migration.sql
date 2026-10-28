-- Signature de chaque membre du staff, collée sous ses macros et ses réponses de ticket,
-- et choix d'envoyer à son nom (webhook) plutôt qu'au nom du bot.
CREATE TABLE IF NOT EXISTS "ticket_staff_signatures" (
  "guildId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "content" TEXT NOT NULL DEFAULT '',
  "sendAsMe" BOOLEAN NOT NULL DEFAULT false,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ticket_staff_signatures_pkey" PRIMARY KEY ("guildId", "userId")
);

ALTER TABLE "ticket_staff_signatures"
  DROP CONSTRAINT IF EXISTS "ticket_staff_signatures_guildId_fkey";
ALTER TABLE "ticket_staff_signatures"
  ADD CONSTRAINT "ticket_staff_signatures_guildId_fkey"
  FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
