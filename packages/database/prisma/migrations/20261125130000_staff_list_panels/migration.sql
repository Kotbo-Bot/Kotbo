-- Panneaux Discord listant le staff par grade.
CREATE TABLE IF NOT EXISTS "staff_list_panels" (
  "id" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "messageId" TEXT,
  "title" TEXT NOT NULL,
  "hierarchyId" TEXT,
  "renderHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "staff_list_panels_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "staff_list_panels_guildId_idx" ON "staff_list_panels"("guildId");

ALTER TABLE "staff_list_panels"
  DROP CONSTRAINT IF EXISTS "staff_list_panels_guildId_fkey";
ALTER TABLE "staff_list_panels"
  ADD CONSTRAINT "staff_list_panels_guildId_fkey"
  FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
