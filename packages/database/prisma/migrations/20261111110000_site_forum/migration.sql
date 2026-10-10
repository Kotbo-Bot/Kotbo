-- Site communautaire : forum, par catégorie propre au site ou miroir d'un
-- salon forum Discord. Rejouable : chaque création est gardée.

DO $$ BEGIN
    CREATE TYPE "SiteForumMode" AS ENUM ('SITE', 'MIRROR');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "site_forum_categories" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "mode" "SiteForumMode" NOT NULL DEFAULT 'SITE',
    "channelId" TEXT,
    "webhookId" TEXT,
    "webhookToken" TEXT,
    "writeRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "staffTopicsOnly" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "site_forum_categories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "site_forum_categories_slug_key" ON "site_forum_categories"("siteId", "slug");
CREATE INDEX IF NOT EXISTS "site_forum_categories_guildId_idx" ON "site_forum_categories"("guildId");
CREATE INDEX IF NOT EXISTS "site_forum_categories_channelId_idx" ON "site_forum_categories"("channelId");

CREATE TABLE IF NOT EXISTS "site_forum_topics" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "threadId" TEXT,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "replyCount" INTEGER NOT NULL DEFAULT 0,
    "lastPostAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastPostBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "site_forum_topics_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "site_forum_topics_threadId_key" ON "site_forum_topics"("threadId");
CREATE INDEX IF NOT EXISTS "site_forum_topics_categoryId_deletedAt_pinned_lastPostAt_idx" ON "site_forum_topics"("categoryId", "deletedAt", "pinned", "lastPostAt");
CREATE INDEX IF NOT EXISTS "site_forum_topics_guildId_idx" ON "site_forum_topics"("guildId");

CREATE TABLE IF NOT EXISTS "site_forum_posts" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "authorAvatar" TEXT,
    "content" TEXT NOT NULL,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "messageId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'site',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "site_forum_posts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "site_forum_posts_messageId_key" ON "site_forum_posts"("messageId");
CREATE INDEX IF NOT EXISTS "site_forum_posts_topicId_createdAt_idx" ON "site_forum_posts"("topicId", "createdAt");
CREATE INDEX IF NOT EXISTS "site_forum_posts_guildId_createdAt_idx" ON "site_forum_posts"("guildId", "createdAt");

DO $$ BEGIN
    ALTER TABLE "site_forum_categories" ADD CONSTRAINT "site_forum_categories_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "community_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "site_forum_topics" ADD CONSTRAINT "site_forum_topics_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "site_forum_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "site_forum_posts" ADD CONSTRAINT "site_forum_posts_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "site_forum_topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
