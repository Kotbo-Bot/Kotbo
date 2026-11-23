-- CreateTable
CREATE TABLE "sanction_deletions" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "sanctionId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "reportIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "evidenceFileIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deletedByUserId" TEXT NOT NULL,
    "deletedByTag" TEXT,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restoredAt" TIMESTAMP(3),

    CONSTRAINT "sanction_deletions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sanction_deletions_guildId_deletedAt_idx" ON "sanction_deletions"("guildId", "deletedAt");

-- CreateIndex
CREATE INDEX "sanction_deletions_deletedAt_idx" ON "sanction_deletions"("deletedAt");

-- AddForeignKey
ALTER TABLE "sanction_deletions" ADD CONSTRAINT "sanction_deletions_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
