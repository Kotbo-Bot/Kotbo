-- Fiches confidentielles : notes datées sur une personne, avec leur échéance.
ALTER TABLE "wellbeing_configs" ADD COLUMN "profileRetentionMonths" INTEGER NOT NULL DEFAULT 12;

CREATE TABLE "wellbeing_profiles" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "subjectUserId" TEXT NOT NULL,
    "subjectName" TEXT NOT NULL,
    "subjectLeftAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wellbeing_profiles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "wellbeing_profiles_guildId_subjectUserId_key" ON "wellbeing_profiles"("guildId", "subjectUserId");
ALTER TABLE "wellbeing_profiles" ADD CONSTRAINT "wellbeing_profiles_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "wellbeing_profile_notes" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "purgeWarnedAt" TIMESTAMP(3),
    "extendedAt" TIMESTAMP(3),
    "extendedById" TEXT,
    "extendedByName" TEXT,
    "extendedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wellbeing_profile_notes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "wellbeing_profile_notes_profileId_createdAt_idx" ON "wellbeing_profile_notes"("profileId", "createdAt");
CREATE INDEX "wellbeing_profile_notes_expiresAt_idx" ON "wellbeing_profile_notes"("expiresAt");
ALTER TABLE "wellbeing_profile_notes" ADD CONSTRAINT "wellbeing_profile_notes_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "wellbeing_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
