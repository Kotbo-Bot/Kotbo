-- Boutique du serveur en monnaie du bot : offres (rôles, objets, XP,
-- abonnements, prestations), commandes, codes promo, rôles temporaires et
-- abonnements. Rejouable : chaque création est gardée.

DO $$ BEGIN
    CREATE TYPE "ShopOfferKind" AS ENUM ('ROLE', 'ITEM', 'XP', 'SUBSCRIPTION', 'CUSTOM');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE "ShopOrderStatus" AS ENUM ('PENDING', 'COMPLETED', 'REFUSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE "ShopSubscriptionStatus" AS ENUM ('ACTIVE', 'GRACE', 'ENDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "shop_settings" (
    "guildId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "approvalChannelId" TEXT,
    "logChannelId" TEXT,
    "graceDays" INTEGER NOT NULL DEFAULT 3,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "shop_settings_pkey" PRIMARY KEY ("guildId")
);

CREATE TABLE IF NOT EXISTS "shop_offers" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "kind" "ShopOfferKind" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "imageUrl" TEXT,
    "category" TEXT,
    "price" INTEGER NOT NULL,
    "roleId" TEXT,
    "durationDays" INTEGER,
    "itemId" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "stock" INTEGER,
    "perMemberLimit" INTEGER,
    "requiredRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "minLevel" INTEGER NOT NULL DEFAULT 0,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "giftable" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "shop_offers_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "shop_offers_guildId_enabled_idx" ON "shop_offers"("guildId", "enabled");

CREATE TABLE IF NOT EXISTS "shop_orders" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "offerId" TEXT,
    "offerName" TEXT NOT NULL,
    "kind" "ShopOfferKind" NOT NULL,
    "buyerId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "listPrice" INTEGER NOT NULL,
    "promoCodeId" TEXT,
    "status" "ShopOrderStatus" NOT NULL,
    "source" TEXT NOT NULL,
    "note" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "refusalReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shop_orders_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "shop_orders_guildId_status_createdAt_idx" ON "shop_orders"("guildId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "shop_orders_guildId_buyerId_createdAt_idx" ON "shop_orders"("guildId", "buyerId", "createdAt");
CREATE INDEX IF NOT EXISTS "shop_orders_guildId_recipientId_createdAt_idx" ON "shop_orders"("guildId", "recipientId", "createdAt");
CREATE INDEX IF NOT EXISTS "shop_orders_offerId_recipientId_idx" ON "shop_orders"("offerId", "recipientId");

CREATE TABLE IF NOT EXISTS "shop_promo_codes" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "percentOff" INTEGER,
    "amountOff" INTEGER,
    "maxUses" INTEGER,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "offerIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shop_promo_codes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "shop_promo_codes_code_key" ON "shop_promo_codes"("guildId", "code");

CREATE TABLE IF NOT EXISTS "shop_role_grants" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "orderId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shop_role_grants_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "shop_role_grants_guildId_userId_roleId_idx" ON "shop_role_grants"("guildId", "userId", "roleId");
CREATE INDEX IF NOT EXISTS "shop_role_grants_removedAt_expiresAt_idx" ON "shop_role_grants"("removedAt", "expiresAt");

CREATE TABLE IF NOT EXISTS "shop_subscriptions" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "periodDays" INTEGER NOT NULL,
    "status" "ShopSubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "nextChargeAt" TIMESTAMP(3) NOT NULL,
    "graceUntil" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "shop_subscriptions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "shop_subscriptions_member_key" ON "shop_subscriptions"("offerId", "userId");
CREATE INDEX IF NOT EXISTS "shop_subscriptions_status_nextChargeAt_idx" ON "shop_subscriptions"("status", "nextChargeAt");
CREATE INDEX IF NOT EXISTS "shop_subscriptions_guildId_userId_idx" ON "shop_subscriptions"("guildId", "userId");

DO $$ BEGIN
    ALTER TABLE "shop_orders" ADD CONSTRAINT "shop_orders_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "shop_offers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "shop_subscriptions" ADD CONSTRAINT "shop_subscriptions_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "shop_offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
