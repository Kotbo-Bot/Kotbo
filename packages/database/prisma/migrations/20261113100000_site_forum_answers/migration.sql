-- Forum du site : sujet résolu et réponse acceptée, pour que les sujets
-- s'indexent en questions-réponses. Rejouable.

ALTER TABLE "site_forum_topics" ADD COLUMN IF NOT EXISTS "solved" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "site_forum_topics" ADD COLUMN IF NOT EXISTS "acceptedPostId" TEXT;
