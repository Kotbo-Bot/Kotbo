-- Shield Update, vague 5 : synchronisation quarantaine Discord et slowmode préventif.
ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "discordQuarantineSyncEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "automod_configs"
  ADD COLUMN IF NOT EXISTS "preventiveSlowmodeEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "preventiveSlowmodeMsgThreshold" INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS "preventiveSlowmodeMinUsers" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS "preventiveSlowmodeWindowSec" INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS "preventiveSlowmodeSeconds" INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS "preventiveSlowmodeMinutes" INTEGER NOT NULL DEFAULT 5;
