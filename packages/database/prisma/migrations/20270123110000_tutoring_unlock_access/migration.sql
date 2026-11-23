-- AlterTable
ALTER TABLE "testing_periods" ADD COLUMN "unlockFeatureKeys" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "dashboard_feature_user_accesses" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "featureKey" TEXT NOT NULL,
    "canView" BOOLEAN NOT NULL DEFAULT true,
    "canModerate" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'TUTORING',
    "sourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dashboard_feature_user_accesses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dashboard_feature_user_accesses_guildId_userId_featureKey_key" ON "dashboard_feature_user_accesses"("guildId", "userId", "featureKey");

-- CreateIndex
CREATE INDEX "dashboard_feature_user_accesses_guildId_sourceId_idx" ON "dashboard_feature_user_accesses"("guildId", "sourceId");

-- AddForeignKey
ALTER TABLE "dashboard_feature_user_accesses" ADD CONSTRAINT "dashboard_feature_user_accesses_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
