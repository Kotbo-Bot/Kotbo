-- Site communautaire : galerie de thèmes partagés entre serveurs.
-- Rejouable : chaque création est gardée.

CREATE TABLE IF NOT EXISTS "site_theme_shares" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "authorName" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "theme" TEXT NOT NULL,
    "themeSettings" JSONB NOT NULL DEFAULT '{}',
    "customCss" TEXT,
    "templates" JSONB NOT NULL DEFAULT '[]',
    "navigation" JSONB,
    "installs" INTEGER NOT NULL DEFAULT 0,
    "reports" INTEGER NOT NULL DEFAULT 0,
    "hiddenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "site_theme_shares_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "site_theme_shares_guildId_idx" ON "site_theme_shares"("guildId");
CREATE INDEX IF NOT EXISTS "site_theme_shares_hiddenAt_installs_idx" ON "site_theme_shares"("hiddenAt", "installs");
CREATE INDEX IF NOT EXISTS "site_theme_shares_hiddenAt_createdAt_idx" ON "site_theme_shares"("hiddenAt", "createdAt");

CREATE TABLE IF NOT EXISTS "site_theme_installs" (
    "shareId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "site_theme_installs_pkey" PRIMARY KEY ("shareId", "guildId")
);

CREATE TABLE IF NOT EXISTS "site_theme_reports" (
    "shareId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "site_theme_reports_pkey" PRIMARY KEY ("shareId", "guildId")
);

DO $$ BEGIN
    ALTER TABLE "site_theme_shares" ADD CONSTRAINT "site_theme_shares_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "community_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "site_theme_installs" ADD CONSTRAINT "site_theme_installs_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "site_theme_shares"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "site_theme_reports" ADD CONSTRAINT "site_theme_reports_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "site_theme_shares"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
