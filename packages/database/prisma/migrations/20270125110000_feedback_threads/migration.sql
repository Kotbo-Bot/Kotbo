-- Retours du dashboard : suivi par statut et conversation avec les admins.
CREATE TABLE IF NOT EXISTS "feedbacks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "guildId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feedbacks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "feedback_messages" (
    "id" TEXT NOT NULL,
    "feedbackId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "fromStaff" BOOLEAN NOT NULL DEFAULT false,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "feedbacks_userId_createdAt_idx" ON "feedbacks"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "feedbacks_status_createdAt_idx" ON "feedbacks"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "feedback_messages_feedbackId_createdAt_idx" ON "feedback_messages"("feedbackId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "feedback_messages" ADD CONSTRAINT "feedback_messages_feedbackId_fkey" FOREIGN KEY ("feedbackId") REFERENCES "feedbacks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
