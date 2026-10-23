-- Site communautaire : site public par serveur, pages (libres, wiki, blog),
-- révisions, commentaires, images, signalements, fiches staff, fréquentation.
DO $$ BEGIN
    CREATE TYPE "SitePageKind" AS ENUM ('PAGE', 'WIKI', 'BLOG');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE "SiteVisibility" AS ENUM ('PUBLIC', 'MEMBERS', 'ROLES', 'STAFF');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE "SiteCommentStatus" AS ENUM ('VISIBLE', 'PENDING', 'HIDDEN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE "SiteReportStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "community_sites" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT,
    "tagline" TEXT,
    "logoUrl" TEXT,
    "bannerUrl" TEXT,
    "faviconUrl" TEXT,
    "theme" TEXT NOT NULL DEFAULT 'verre',
    "themeSettings" JSONB NOT NULL DEFAULT '{}',
    "customCss" TEXT,
    "navigation" JSONB NOT NULL DEFAULT '[]',
    "homePageId" TEXT,
    "staffPage" JSONB NOT NULL DEFAULT '{}',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "wikiEditorRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "blogEditorRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "wikiAnnounceChannelId" TEXT,
    "blogAnnounceChannelId" TEXT,
    "suspendedAt" TIMESTAMP(3),
    "suspendedReason" TEXT,
    "suspendedById" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "community_sites_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "site_slug_redirects" (
    "slug" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_slug_redirects_pkey" PRIMARY KEY ("slug")
);

CREATE TABLE IF NOT EXISTS "site_pages" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "kind" "SitePageKind" NOT NULL DEFAULT 'PAGE',
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "excerpt" TEXT,
    "coverUrl" TEXT,
    "icon" TEXT,
    "parentId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "visibility" "SiteVisibility" NOT NULL DEFAULT 'PUBLIC',
    "visibleRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "draftContent" JSONB NOT NULL DEFAULT '{"type":"doc","content":[]}',
    "collabState" BYTEA,
    "hasUnpublishedChanges" BOOLEAN NOT NULL DEFAULT true,
    "publishedContent" JSONB,
    "publishedTitle" TEXT,
    "publishedAt" TIMESTAMP(3),
    "firstPublishedAt" TIMESTAMP(3),
    "scheduledAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "commentsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "searchText" TEXT NOT NULL DEFAULT '',
    "authorId" TEXT NOT NULL,
    "lastEditedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_pages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "site_page_revisions" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "authorId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_page_revisions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "site_comments" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "authorAvatar" TEXT,
    "content" TEXT NOT NULL,
    "status" "SiteCommentStatus" NOT NULL DEFAULT 'VISIBLE',
    "moderationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_comments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "site_assets" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "sha256" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_assets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "site_reports" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "pageId" TEXT,
    "path" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "details" TEXT,
    "reporterHash" TEXT NOT NULL,
    "status" "SiteReportStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_reports_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "site_staff_profiles" (
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bio" TEXT,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_staff_profiles_pkey" PRIMARY KEY ("guildId","userId")
);

CREATE TABLE IF NOT EXISTS "site_daily_stats" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "key" TEXT NOT NULL DEFAULT '',
    "views" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_daily_stats_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "site_visitors" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "visitorHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_visitors_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "community_sites_guildId_key" ON "community_sites"("guildId");

CREATE UNIQUE INDEX IF NOT EXISTS "community_sites_slug_key" ON "community_sites"("slug");

CREATE INDEX IF NOT EXISTS "community_sites_published_idx" ON "community_sites"("published");

CREATE INDEX IF NOT EXISTS "site_slug_redirects_siteId_idx" ON "site_slug_redirects"("siteId");

CREATE INDEX IF NOT EXISTS "site_pages_siteId_kind_parentId_sortOrder_idx" ON "site_pages"("siteId", "kind", "parentId", "sortOrder");

CREATE INDEX IF NOT EXISTS "site_pages_siteId_kind_publishedAt_idx" ON "site_pages"("siteId", "kind", "publishedAt");

CREATE INDEX IF NOT EXISTS "site_pages_scheduledAt_idx" ON "site_pages"("scheduledAt");

CREATE UNIQUE INDEX IF NOT EXISTS "site_pages_siteId_kind_slug_key" ON "site_pages"("siteId", "kind", "slug");

CREATE INDEX IF NOT EXISTS "site_page_revisions_pageId_createdAt_idx" ON "site_page_revisions"("pageId", "createdAt");

CREATE INDEX IF NOT EXISTS "site_comments_pageId_status_createdAt_idx" ON "site_comments"("pageId", "status", "createdAt");

CREATE INDEX IF NOT EXISTS "site_comments_guildId_status_createdAt_idx" ON "site_comments"("guildId", "status", "createdAt");

CREATE INDEX IF NOT EXISTS "site_assets_siteId_createdAt_idx" ON "site_assets"("siteId", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "site_assets_siteId_sha256_key" ON "site_assets"("siteId", "sha256");

CREATE INDEX IF NOT EXISTS "site_reports_status_createdAt_idx" ON "site_reports"("status", "createdAt");

CREATE INDEX IF NOT EXISTS "site_reports_siteId_createdAt_idx" ON "site_reports"("siteId", "createdAt");

CREATE INDEX IF NOT EXISTS "site_daily_stats_guildId_dateKey_idx" ON "site_daily_stats"("guildId", "dateKey");

CREATE UNIQUE INDEX IF NOT EXISTS "site_daily_stats_key" ON "site_daily_stats"("siteId", "dateKey", "dimension", "key");

CREATE INDEX IF NOT EXISTS "site_visitors_dateKey_idx" ON "site_visitors"("dateKey");

CREATE UNIQUE INDEX IF NOT EXISTS "site_visitors_key" ON "site_visitors"("siteId", "dateKey", "scope", "visitorHash");

DO $$ BEGIN
    ALTER TABLE "community_sites" ADD CONSTRAINT "community_sites_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "site_slug_redirects" ADD CONSTRAINT "site_slug_redirects_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "community_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "site_pages" ADD CONSTRAINT "site_pages_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "community_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "site_pages" ADD CONSTRAINT "site_pages_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "site_pages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "site_page_revisions" ADD CONSTRAINT "site_page_revisions_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "site_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "site_comments" ADD CONSTRAINT "site_comments_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "site_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "site_assets" ADD CONSTRAINT "site_assets_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "community_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "site_reports" ADD CONSTRAINT "site_reports_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "community_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Recherche plein texte du wiki et du blog. `searchText` est déjà sans accents
-- et en minuscules (normalisé par l'application), d'où la configuration
-- `simple` : pas de racinisation propre à une langue, le contenu d'un serveur
-- n'étant pas forcément en français.
CREATE INDEX IF NOT EXISTS "site_pages_search_idx" ON "site_pages" USING GIN (to_tsvector('simple', "searchText"));
