-- Shield Update, vague 2 : Shield (niveau d'alerte du serveur) et
-- déclenchement du captcha (permanent, automatique, intelligent).
-- Rejouable : chaque ajout est conditionnel.

ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "captchaTrigger" TEXT NOT NULL DEFAULT 'ALWAYS';
ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "captchaUseServerIcon" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "shieldLevel" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "shieldPanelChannelId" TEXT;
ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "shieldPanelMessageId" TEXT;
ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "shieldStatusChannelId" TEXT;
ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "shieldState" JSONB;
ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "shieldChangedAt" TIMESTAMP(3);
ALTER TABLE "raid_protection_configs" ADD COLUMN IF NOT EXISTS "shieldChangedBy" TEXT;
