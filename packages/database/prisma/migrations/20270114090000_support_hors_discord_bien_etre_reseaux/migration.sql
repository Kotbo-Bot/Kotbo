-- AlterTable
ALTER TABLE "guilds" ADD COLUMN     "ticketInboundEmailAddress" TEXT,
ADD COLUMN     "ticketInboundEmailEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ticketInboundEmailSecret" TEXT,
ADD COLUMN     "ticketWebFormEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "quest_definitions" ADD COLUMN     "conditions" JSONB;

-- AlterTable
ALTER TABLE "shop_settings" ADD COLUMN     "webShopAccentColor" TEXT,
ADD COLUMN     "webShopBannerUrl" TEXT,
ADD COLUMN     "webShopCustomCss" TEXT,
ADD COLUMN     "webShopDescription" TEXT,
ADD COLUMN     "webShopEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "webShopTitle" TEXT;

-- AlterTable
ALTER TABLE "staff_members" ADD COLUMN     "generalClearance" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "poleClearances" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "requesterEmail" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'DISCORD',
ADD COLUMN     "webAccessToken" TEXT;

-- AlterTable
ALTER TABLE "tutoring_items" ADD COLUMN     "grantDashboardSection" TEXT,
ADD COLUMN     "grantRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "ticket_web_messages" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorId" TEXT,
    "authorName" TEXT NOT NULL,
    "authorEmail" TEXT,
    "isStaff" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'WEB',
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_web_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wellbeing_configs" (
    "guildId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "teamRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "teamUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "directorRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "directorUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requireReason" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wellbeing_configs_pkey" PRIMARY KEY ("guildId")
);

-- CreateTable
CREATE TABLE "wellbeing_cases" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "subjectUserId" TEXT,
    "subjectName" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'SOUTIEN',
    "severity" TEXT NOT NULL DEFAULT 'NORMAL',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "summary" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wellbeing_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wellbeing_case_notes" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wellbeing_case_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wellbeing_break_glass_logs" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "caseId" TEXT,
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wellbeing_break_glass_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guild_networks" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "planKey" TEXT NOT NULL DEFAULT 'NETWORK_ASSOC',
    "maxGuilds" INTEGER NOT NULL DEFAULT 5,
    "billingStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
    "stripeSubscriptionId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guild_networks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guild_network_members" (
    "id" TEXT NOT NULL,
    "networkId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "addedById" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guild_network_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ticket_web_messages_ticketId_createdAt_idx" ON "ticket_web_messages"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "wellbeing_cases_guildId_status_idx" ON "wellbeing_cases"("guildId", "status");

-- CreateIndex
CREATE INDEX "wellbeing_case_notes_caseId_createdAt_idx" ON "wellbeing_case_notes"("caseId", "createdAt");

-- CreateIndex
CREATE INDEX "wellbeing_break_glass_logs_guildId_actorId_expiresAt_idx" ON "wellbeing_break_glass_logs"("guildId", "actorId", "expiresAt");

-- CreateIndex
CREATE INDEX "guild_networks_ownerUserId_idx" ON "guild_networks"("ownerUserId");

-- CreateIndex
CREATE INDEX "guild_network_members_guildId_idx" ON "guild_network_members"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "guild_network_members_networkId_guildId_key" ON "guild_network_members"("networkId", "guildId");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_webAccessToken_key" ON "tickets"("webAccessToken");

-- AddForeignKey
ALTER TABLE "ticket_web_messages" ADD CONSTRAINT "ticket_web_messages_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wellbeing_configs" ADD CONSTRAINT "wellbeing_configs_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wellbeing_cases" ADD CONSTRAINT "wellbeing_cases_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wellbeing_case_notes" ADD CONSTRAINT "wellbeing_case_notes_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "wellbeing_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wellbeing_break_glass_logs" ADD CONSTRAINT "wellbeing_break_glass_logs_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guild_network_members" ADD CONSTRAINT "guild_network_members_networkId_fkey" FOREIGN KEY ("networkId") REFERENCES "guild_networks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guild_network_members" ADD CONSTRAINT "guild_network_members_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

