-- Site communautaire : articles publiés tout seuls (annonces Discord
-- recopiées, résumé de la semaine). Rejouable : chaque création est gardée.

CREATE TABLE IF NOT EXISTS "site_auto_posts" (
    "key" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "site_auto_posts_pkey" PRIMARY KEY ("key")
);
CREATE INDEX IF NOT EXISTS "site_auto_posts_siteId_idx" ON "site_auto_posts"("siteId");

DO $$ BEGIN
    ALTER TABLE "site_auto_posts" ADD CONSTRAINT "site_auto_posts_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "site_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
