-- Webhooks sortants et journal de leurs envois.
CREATE TABLE IF NOT EXISTS "outgoing_webhooks" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "disabledReason" TEXT,
    "lastDeliveryAt" TIMESTAMP(3),
    "lastStatusCode" INTEGER,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "outgoing_webhooks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "outgoing_webhooks_guildId_idx" ON "outgoing_webhooks"("guildId");
DO $$ BEGIN
    ALTER TABLE "outgoing_webhooks" ADD CONSTRAINT "outgoing_webhooks_guildId_fkey"
        FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "outgoing_webhook_deliveries" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "responseStatus" INTEGER,
    "responseBody" TEXT,
    "durationMs" INTEGER,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "outgoing_webhook_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "outgoing_webhook_deliveries_webhookId_createdAt_idx" ON "outgoing_webhook_deliveries"("webhookId", "createdAt");
CREATE INDEX IF NOT EXISTS "outgoing_webhook_deliveries_status_nextAttemptAt_idx" ON "outgoing_webhook_deliveries"("status", "nextAttemptAt");
CREATE INDEX IF NOT EXISTS "outgoing_webhook_deliveries_guildId_createdAt_idx" ON "outgoing_webhook_deliveries"("guildId", "createdAt");
DO $$ BEGIN
    ALTER TABLE "outgoing_webhook_deliveries" ADD CONSTRAINT "outgoing_webhook_deliveries_webhookId_fkey"
        FOREIGN KEY ("webhookId") REFERENCES "outgoing_webhooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
