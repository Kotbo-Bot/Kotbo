-- AutoMod : spam à plusieurs dans un salon → mode lent au lieu des sanctions individuelles.
ALTER TABLE "automod_configs" ADD COLUMN IF NOT EXISTS "spamGroupSlowmodeEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "automod_configs" ADD COLUMN IF NOT EXISTS "spamGroupSlowmodeSeconds" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "automod_configs" ADD COLUMN IF NOT EXISTS "spamGroupSlowmodeMinutes" INTEGER NOT NULL DEFAULT 5;
