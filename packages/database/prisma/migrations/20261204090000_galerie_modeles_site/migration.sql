-- Galerie de modèles de site partagés entre serveurs (refonte du site,
-- vague 4). Remplace l'ancienne galerie de thèmes retirée le 2026-10-12.
-- Rejouable.

CREATE TABLE IF NOT EXISTS "site_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL DEFAULT 'general',
    "lang" TEXT NOT NULL DEFAULT 'fr',
    "authorGuildId" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "sourceSiteId" TEXT,
    "theme" TEXT NOT NULL,
    "themeSettings" JSONB NOT NULL DEFAULT '{}',
    "navigation" JSONB NOT NULL DEFAULT '[]',
    "pages" JSONB NOT NULL DEFAULT '[]',
    "uses" INTEGER NOT NULL DEFAULT 0,
    "reporterIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "site_templates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "site_templates_hidden_uses_idx" ON "site_templates"("hidden", "uses");
CREATE INDEX IF NOT EXISTS "site_templates_authorGuildId_idx" ON "site_templates"("authorGuildId");
