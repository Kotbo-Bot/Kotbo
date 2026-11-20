-- Historique des attributs d'identité des membres : pseudos, descriptions, pseudos d'affichage, photos de profil, tags et pronoms.
CREATE TABLE IF NOT EXISTS "member_profile_history" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_profile_history_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "member_profile_history_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "member_profile_history_guildId_userId_field_idx" ON "member_profile_history"("guildId", "userId", "field");
CREATE INDEX IF NOT EXISTS "member_profile_history_guildId_userId_recordedAt_idx" ON "member_profile_history"("guildId", "userId", "recordedAt");
CREATE INDEX IF NOT EXISTS "member_profile_history_userId_field_idx" ON "member_profile_history"("userId", "field");
