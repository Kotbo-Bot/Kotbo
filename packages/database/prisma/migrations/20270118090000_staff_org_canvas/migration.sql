-- CreateTable
CREATE TABLE "staff_org_canvases" (
    "guildId" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_org_canvases_pkey" PRIMARY KEY ("guildId")
);

-- AddForeignKey
ALTER TABLE "staff_org_canvases" ADD CONSTRAINT "staff_org_canvases_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
