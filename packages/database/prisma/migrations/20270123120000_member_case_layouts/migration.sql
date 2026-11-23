-- CreateTable
CREATE TABLE "member_case_layouts" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "roleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tabOrder" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hiddenTabs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_case_layouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "member_case_layouts_guildId_position_idx" ON "member_case_layouts"("guildId", "position");

-- AddForeignKey
ALTER TABLE "member_case_layouts" ADD CONSTRAINT "member_case_layouts_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
