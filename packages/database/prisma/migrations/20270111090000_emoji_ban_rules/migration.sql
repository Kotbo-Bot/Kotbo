-- Emojis, stickers et serveurs d'origine interdits, une sanction par règle.
CREATE TABLE IF NOT EXISTS "emoji_ban_rules" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT,
    "iconUrl" TEXT,
    "action" TEXT NOT NULL DEFAULT 'DELETE',
    "durationMin" INTEGER,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "emoji_ban_rules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "emoji_ban_rules_guildId_kind_key_key" ON "emoji_ban_rules"("guildId", "kind", "key");
CREATE INDEX IF NOT EXISTS "emoji_ban_rules_guildId_idx" ON "emoji_ban_rules"("guildId");
