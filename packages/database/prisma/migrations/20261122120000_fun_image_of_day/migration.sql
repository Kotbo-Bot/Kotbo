-- Salon fun « Image du jour » : une image par membre et par jour.
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "funImageOfDayChannelId" TEXT;
