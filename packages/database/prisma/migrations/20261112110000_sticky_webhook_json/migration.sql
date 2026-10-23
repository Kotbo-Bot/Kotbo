-- Sticky : payload Discord brut (embeds, composants) et identité personnalisée
-- par webhook. Rejouable.

ALTER TABLE "sticky_messages"
    ADD COLUMN IF NOT EXISTS "jsonEnabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "jsonPayload" TEXT,
    ADD COLUMN IF NOT EXISTS "webhookEnabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "webhookName" TEXT,
    ADD COLUMN IF NOT EXISTS "webhookAvatarUrl" TEXT,
    ADD COLUMN IF NOT EXISTS "webhookId" TEXT,
    ADD COLUMN IF NOT EXISTS "webhookToken" TEXT;
